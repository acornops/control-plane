import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { getAgentDefinition, updateAgentReadiness } from '../store/repository-agents.js';
import { updateWorkflowReadiness } from '../store/repository-workflows.js';
import { capabilitiesOutsideAgentCeiling, resolveEffectiveWorkflowCapabilityIds } from './workflow-capability-policy.js';
import { repo } from '../store/repository.js';
import {
  capabilityRequiresExactTarget,
  targetAllowedByAgentScope,
  targetAllowedByMapping,
  targetAllowedByWorkflowConstraints
} from './target-scope-authorization.js';
import { workflowTargetPolicy } from './prompt-resources/providers/target-provider.js';

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function computeAgentReadiness(agent: AgentDefinition): Promise<AgentDefinition['readiness']> {
  if (agent.status !== 'active' || agent.reviewState !== 'reviewed') {
    return { status: 'blocked', reasons: ['Agent must be active and reviewed.'] };
  }
  const mappings = await listCapabilityRoutingMappings(agent.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: agent.semanticCapabilityIds
  });
  const mapped = new Set(mappings
    .filter((mapping) => mapping.agentId === agent.id && mapping.agentVersion === agent.version)
    .map((mapping) => mapping.capabilityId));
  const missing: string[] = [];
  for (const capabilityId of agent.semanticCapabilityIds) {
    const capabilityMappings = mappings.filter((mapping) => mapping.capabilityId === capabilityId
      && mapping.agentId === agent.id && mapping.agentVersion === agent.version);
    if (!mapped.has(capabilityId)) {
      missing.push(capabilityId);
      continue;
    }
    if (!capabilityRequiresExactTarget(capabilityId)) continue;
    if (agent.targetScope.targetIds?.length) {
      for (const targetId of agent.targetScope.targetIds) {
        const target = await repo.getTarget(agent.workspaceId, targetId);
        if (!target || !targetAllowedByAgentScope(agent.targetScope, target)
          || !capabilityMappings.some((mapping) => targetAllowedByMapping(mapping, target)
            && (mapping.targetToolRefs.length || mapping.nativeToolIds.length))) {
          missing.push(capabilityId);
          break;
        }
      }
    } else {
      let eligiblePair = false;
      for (const mapping of capabilityMappings) {
        if (!mapping.targetToolRefs.length && !mapping.nativeToolIds.length) continue;
        if (!mapping.targetIds.length && (agent.targetScope.targetTypes || []).every((targetType) => (
          !mapping.targetTypes.length || mapping.targetTypes.includes(targetType)
        ))) {
          eligiblePair = true;
          break;
        }
        for (const targetId of mapping.targetIds) {
          const target = await repo.getTarget(agent.workspaceId, targetId);
          if (target && targetAllowedByAgentScope(agent.targetScope, target) && targetAllowedByMapping(mapping, target)) {
            eligiblePair = true;
            break;
          }
        }
        if (eligiblePair) break;
      }
      if (!eligiblePair) missing.push(capabilityId);
    }
  }
  return missing.length > 0
    ? { status: 'needs_setup', reasons: missing.map((capabilityId) => `No active reviewed live-resource mapping for ${capabilityId}.`) }
    : { status: 'ready', reasons: [] };
}

export async function refreshAgentReadiness(workspaceId: string, agentId: string): Promise<AgentDefinition | null> {
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) return null;
  return updateAgentReadiness(workspaceId, agentId, await computeAgentReadiness(agent));
}

export async function computeWorkflowReadiness(workflow: WorkflowDefinitionForAccess): Promise<NonNullable<WorkflowDefinitionForAccess['readiness']>> {
  if (workflow.agentIds.length === 0) {
    return { status: 'blocked', reasons: ['WORKFLOW_AGENT_SELECTION_REQUIRED'] };
  }
  const selected = (await Promise.all(
    workflow.agentIds.map((agentId) => getAgentDefinition(workflow.workspaceId, agentId))
  )).filter((agent): agent is AgentDefinition => Boolean(agent));
  const unavailable = workflow.agentIds.filter((agentId) => !selected.some((agent) => (
    agent.id === agentId
    && agent.status === 'active'
    && agent.reviewState === 'reviewed'
  )));
  if (unavailable.length > 0) {
    return {
      status: 'blocked',
      reasons: unavailable.map((agentId) => `Selected Agent ${agentId} must remain an active, reviewed specialist.`)
    };
  }
  const requested = resolveEffectiveWorkflowCapabilityIds(workflow.capabilityPolicy, selected);
  const outside = capabilitiesOutsideAgentCeiling(workflow.capabilityPolicy, selected);
  if (outside.length > 0) {
    return { status: 'blocked', reasons: outside.map((capabilityId) => `Selected Agents do not include ${capabilityId}.`) };
  }

  const selectedById = new Map(selected.map((agent) => [agent.id, agent]));
  const mappings = await listCapabilityRoutingMappings(workflow.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: requested
  });
  const targetConstraints = workflowTargetPolicy(workflow);
  const eligibleMappings = mappings.filter((mapping) => {
    const agent = selectedById.get(mapping.agentId);
    return Boolean(agent && mapping.agentVersion === agent.version);
  });
  const unmapped: string[] = [];
  for (const capabilityId of requested) {
    const capabilityMappings = eligibleMappings.filter((mapping) => mapping.capabilityId === capabilityId);
    if (!capabilityMappings.length) {
      unmapped.push(capabilityId);
      continue;
    }
    let covered = true;
    for (const targetId of targetConstraints?.targetIds || []) {
      const target = await repo.getTarget(workflow.workspaceId, targetId);
      if (!target || !targetAllowedByWorkflowConstraints(targetConstraints, target)
        || !capabilityMappings.some((mapping) => {
          const agent = selectedById.get(mapping.agentId);
          return Boolean(agent && targetAllowedByAgentScope(agent.targetScope, target) && targetAllowedByMapping(mapping, target));
        })) {
        covered = false;
        break;
      }
    }
    if (covered && capabilityRequiresExactTarget(capabilityId) && !(targetConstraints?.targetIds.length)) {
      covered = false;
      for (const mapping of capabilityMappings) {
        const agent = selectedById.get(mapping.agentId);
        if (!agent || (!mapping.targetToolRefs.length && !mapping.nativeToolIds.length)) continue;
        if (!mapping.targetIds.length) {
          const constrainedTypes = targetConstraints?.targetTypes || [];
          if (constrainedTypes.every((targetType) => (
            (!mapping.targetTypes.length || mapping.targetTypes.includes(targetType))
            && (!agent.targetScope.targetTypes?.length || agent.targetScope.targetTypes.includes(targetType))
          ))) {
            covered = true;
            break;
          }
        }
        for (const targetId of mapping.targetIds) {
          const target = await repo.getTarget(workflow.workspaceId, targetId);
          if (target
            && targetAllowedByWorkflowConstraints(targetConstraints, target)
            && targetAllowedByAgentScope(agent.targetScope, target)
            && targetAllowedByMapping(mapping, target)) {
            covered = true;
            break;
          }
        }
        if (covered) break;
      }
    } else if (covered) {
      covered = (targetConstraints?.targetTypes || []).every((targetType) => capabilityMappings.some((mapping) => (
        !mapping.targetTypes.length || mapping.targetTypes.includes(targetType)
      )));
    }
    if (!covered) unmapped.push(capabilityId);
  }
  if (unmapped.length > 0) {
    return {
      status: 'needs_setup',
      reasons: unmapped.map((capabilityId) => `No selected specialist has an active reviewed mapping for ${capabilityId}.`)
    };
  }
  return { status: 'ready', reasons: [] };
}

export async function refreshWorkflowReadiness(workflow: WorkflowDefinitionForAccess): Promise<WorkflowDefinitionForAccess | null> {
  return updateWorkflowReadiness(workflow.workspaceId, workflow.id, await computeWorkflowReadiness(workflow));
}
