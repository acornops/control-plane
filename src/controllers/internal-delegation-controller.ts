import type { NextFunction, Request, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { WORKSPACE_CAPABILITIES, type WorkspacePermissions } from '../auth/authorization.js';
import { db } from '../infra/db.js';
import { observeWorkflowDelegationOutcome } from '../metrics.js';
import { compileAgentRunScope } from '../services/agent-access.js';
import { promptResourceRegistry } from '../services/prompt-resources/index.js';
import { clampDelegationLimits } from '../services/coordination-functions.js';
import { selectDelegationCandidate } from '../services/workflow-access.js';
import { getExactMcpReadinessErrors } from '../services/workflow-readiness.js';
import { listAgentDefinitions, createAgentRunActivity } from '../store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import {
  attachDelegationChild,
  failWorkflowDelegation,
  listWorkflowDelegations,
  reserveWorkflowDelegation
} from '../store/repository-workflow-delegations.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import type { AgentDefinition } from '../types/agents.js';
import type { TargetType } from '../types/domain.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';

function badRequest(res: Response, code: string, message: string, status = 409): void {
  res.status(status).json({ error: { code, message, retryable: false } });
}

async function pinnedWorkflow(executionId: string): Promise<WorkflowDefinitionForAccess | null> {
  const result = await db.query<QueryResultRow>(
    'SELECT workflow_snapshot FROM workflow_executions WHERE id=$1',
    [executionId]
  );
  const snapshot = result.rows[0]?.workflow_snapshot;
  return snapshot && typeof snapshot === 'object' ? snapshot as WorkflowDefinitionForAccess : null;
}

function currentPermissions(granted: string[]): WorkspacePermissions {
  const allowed = new Set(granted);
  return Object.fromEntries(WORKSPACE_CAPABILITIES.map((capability) => [capability, allowed.has(capability)])) as WorkspacePermissions;
}

export async function delegateSpecialist(req: Request, res: Response, next: NextFunction): Promise<void> {
  let delegationId: string | undefined;
  const startedAt = Date.now();
  try {
    const parent = await getWorkflowRun(toSingleParam(req.params.runId));
    if (!parent || parent.endedAt) {
      badRequest(res, 'DELEGATION_PARENT_UNAVAILABLE', 'The parent workflow run is unavailable.');
      return;
    }
    const manager = parent.agentSnapshot as unknown as AgentDefinition | undefined;
    if (!manager || manager.kind !== 'manager' || parent.compiledAccessScope.entryAgent.kind !== 'manager') {
      badRequest(res, 'DELEGATION_MANAGER_REQUIRED', 'Only a Manager entry Agent may delegate.', 403);
      return;
    }
    const capabilityId = typeof req.body?.capabilityId === 'string' ? req.body.capabilityId.trim() : '';
    const taskPrompt = typeof req.body?.taskPrompt === 'string' ? req.body.taskPrompt.trim() : '';
    const binding = req.body?.targetBinding as { id?: unknown; targetType?: unknown } | undefined;
    const targetId = typeof binding?.id === 'string' ? binding.id.trim() : '';
    const targetType = binding?.targetType;
    const required = req.body?.required !== false;
    if (!capabilityId || !taskPrompt || !targetId || (targetType !== 'kubernetes' && targetType !== 'virtual_machine')) {
      badRequest(res, 'DELEGATION_REQUEST_INVALID', 'capabilityId, taskPrompt, and an exact targetBinding are required.', 400);
      return;
    }
    if (!parent.compiledAccessScope.semanticCapabilityIds.includes(capabilityId)) {
      badRequest(res, 'DELEGATION_CAPABILITY_DENIED', 'The requested capability is outside the pinned workflow allowlist.', 403);
      return;
    }
    const workflow = await pinnedWorkflow(parent.executionId);
    if (!workflow) {
      badRequest(res, 'DELEGATION_WORKFLOW_SNAPSHOT_MISSING', 'The pinned workflow snapshot is unavailable.');
      return;
    }
    if (!parent.prompt.trim()) {
      badRequest(res, 'DELEGATION_PROMPT_SNAPSHOT_MISSING', 'The exact parent prompt is unavailable.');
      return;
    }
    const parentResolution = await promptResourceRegistry.resolve(parent.prompt, {
      workspaceId: parent.workspaceId,
      actorUserId: parent.compiledAccessScope.actor.userId,
      workflowId: parent.workflowId,
      workflowSessionId: parent.workflowSessionId,
      initiatingMessageId: parent.messageId,
      source: parent.resourceBindings.some((resourceBinding) => resourceBinding.source === 'trigger')
        ? 'trigger'
        : 'explicit',
      mode: 'launch',
      requirements: workflow.resourceRequirements || []
    });
    if (parentResolution.blockers.length > 0) {
      badRequest(
        res,
        'DELEGATION_PROMPT_REFERENCES_BLOCKED',
        parentResolution.blockers.map((blocker) => blocker.message).slice(0, 3).join(' ')
      );
      return;
    }
    const targetGranted = parentResolution.bindings.some((resourceBinding) => {
      const projection = promptResourceRegistry.projectRuntime([resourceBinding], parent.id);
      const route = projection.targetRoute && typeof projection.targetRoute === 'object'
        ? projection.targetRoute as Record<string, unknown>
        : undefined;
      return route?.id === targetId && route.targetType === targetType;
    });
    if (!targetGranted) {
      badRequest(res, 'DELEGATION_TARGET_DENIED', 'The requested target is outside the pinned workflow targets.', 403);
      return;
    }
    const target = await (await import('../store/repository.js')).repo.getTarget(parent.workspaceId, targetId);
    if (!target || target.status === 'offline' || target.targetType !== targetType) {
      badRequest(res, 'DELEGATION_TARGET_NOT_READY', 'The exact target is unavailable or incompatible.');
      return;
    }
    if (parent.compiledAccessScope.principal.type === 'user') {
      const membership = await db.query(
        'SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
        [parent.workspaceId, parent.compiledAccessScope.principal.id]
      );
      if (!membership.rowCount) {
        badRequest(res, 'DELEGATION_PRINCIPAL_DENIED', 'The pinned principal no longer has workspace access.', 403);
        return;
      }
    }
    const [agents, mappings] = await Promise.all([
      listAgentDefinitions(parent.workspaceId, { includeInactive: true }),
      listCapabilityRoutingMappings(parent.workspaceId, { activeReviewedOnly: true, capabilityIds: [capabilityId] })
    ]);
    const selected = selectDelegationCandidate({
      manager,
      workflow,
      capabilityId,
      target: { id: targetId, targetType: targetType as TargetType },
      agents,
      mappings
    });
    if (!selected) {
      observeWorkflowDelegationOutcome('unavailable', Date.now() - startedAt);
      badRequest(res, 'DELEGATION_SPECIALIST_UNAVAILABLE', 'No eligible reviewed specialist is ready for the requested capability and target.');
      return;
    }
    if (selected.mapping.contextGrants.some((grant) => !parent.compiledAccessScope.contextGrants.includes(grant))) {
      badRequest(res, 'DELEGATION_CONTEXT_DENIED', 'The specialist mapping requires context outside the parent scope.', 403);
      return;
    }
    const narrowedAgent: AgentDefinition = {
      ...selected.agent,
      semanticCapabilityIds: [capabilityId],
      permissionMode: parent.compiledAccessScope.mode === 'read_only' ? 'read_only' : selected.agent.permissionMode,
      targetScope: { type: 'selected_target', targetTypes: [targetType as TargetType], targetIds: [targetId] }
    };
    const compiledScope = compileAgentRunScope({
      agent: narrowedAgent,
      actor: {
        userId: parent.compiledAccessScope.actor.userId,
        role: parent.compiledAccessScope.actor.role,
        permissions: currentPermissions(parent.compiledAccessScope.grantedCapabilities)
      },
      approvedContextGrants: parent.compiledAccessScope.contextGrants,
      principal: parent.compiledAccessScope.principal,
      mappings: [selected.mapping],
      invocationScope: 'workflow'
    });
    const mcpReadinessErrors = await getExactMcpReadinessErrors(
      parent.workspaceId,
      compiledScope.principal,
      compiledScope.mcpTools
    );
    if (mcpReadinessErrors.length > 0) {
      badRequest(
        res,
        mcpReadinessErrors[0].startsWith('MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED')
          ? 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED'
          : 'MCP_CONNECTION_REQUIRED',
        mcpReadinessErrors[0]
      );
      return;
    }
    const limits = clampDelegationLimits(workflow.delegationPolicy);
    const delegation = await reserveWorkflowDelegation({
      workspaceId: parent.workspaceId,
      parentExecutionId: parent.executionId,
      capabilityId,
      targetBinding: { id: targetId, targetType: targetType as TargetType },
      taskPrompt,
      required,
      selectedAgentId: selected.agent.id,
      selectedAgentVersion: selected.agent.version,
      compiledScope,
      ...limits
    });
    delegationId = delegation.id;
    const child = await createAgentRunActivity({
      agent: narrowedAgent,
      triggeredBy: { type: 'user', userId: parent.compiledAccessScope.actor.userId },
      prompt: taskPrompt,
      inputContext: { parentWorkflowRunId: parent.id, delegationId: delegation.id, capabilityId },
      compiledScope,
      clientRequestId: `delegation:${delegation.id}`,
      targetId,
      targetType: targetType as TargetType
    });
    await attachDelegationChild(delegation.id, child.id);
    observeWorkflowDelegationOutcome('selected', Date.now() - startedAt);
    res.status(201).json({ delegationId: delegation.id, childRunId: child.id, status: child.status,
      capabilityId, targetBinding: delegation.targetBinding, selectedAgentId: selected.agent.id });
  } catch (error) {
    observeWorkflowDelegationOutcome('failed', Date.now() - startedAt);
    if (delegationId) await failWorkflowDelegation(delegationId, 'DELEGATION_CREATION_FAILED', error instanceof Error ? error.message : 'Delegation creation failed.');
    if (error instanceof Error && error.message === 'DELEGATION_TOTAL_LIMIT') {
      badRequest(res, error.message, 'The Manager run reached its total child limit.');
      return;
    }
    if (error instanceof Error && error.message === 'DELEGATION_CONCURRENCY_LIMIT') {
      badRequest(res, error.message, 'The Manager run reached its concurrent child limit.');
      return;
    }
    next(error);
  }
}

export async function awaitDelegations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parent = await getWorkflowRun(toSingleParam(req.params.runId));
    if (!parent || parent.compiledAccessScope.entryAgent.kind !== 'manager') {
      badRequest(res, 'DELEGATION_MANAGER_REQUIRED', 'Only a Manager workflow run may await delegations.', 403);
      return;
    }
    const items = await listWorkflowDelegations(parent.executionId);
    res.status(200).json({ items, pending: items.filter((item) => ['queued', 'dispatching', 'running', 'waiting_for_approval'].includes(item.status)).length });
  } catch (error) {
    next(error);
  }
}
