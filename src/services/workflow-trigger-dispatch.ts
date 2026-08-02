import { randomUUID } from 'node:crypto';

import type { WorkflowSchedulePrincipal } from '../types/workflows.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  getWorkflowExecutionByTriggerOccurrence
} from '../store/repository-workflows.js';
import { computeWorkflowReadiness } from './automation-readiness.js';
import {
  compileWorkflowAccessScope,
  compileWorkflowSessionCeiling,
  WorkflowAccessDeniedError
} from './workflow-access.js';
import { emitWorkflowExecutionEvents } from './workflow-execution-events.js';
import { isModelAllowedForProvider } from './llm-policy.js';
import { PromptResourceProviderError } from './prompt-resources/index.js';
import { resolveRunPrincipal } from './run-principal.js';
import { getWorkflowCapabilityReadinessErrors } from './mcp-readiness.js';
import {
  compileWorkflowPrompt,
  WorkflowPromptValidationError
} from './workflow-prompt.js';
import { resolveWorkspaceLlmSettings } from './workspace-ai-resolution.js';

export interface WorkflowTriggerDispatchInput {
  id: string;
  name: string;
  workspaceId: string;
  workflowId: string;
  approvedContextGrants: string[];
  principal: WorkflowSchedulePrincipal;
  triggerType: 'schedule' | 'webhook';
  occurrenceKey: string;
}

export type WorkflowTriggerDispatchResult =
  | {
      outcome: 'auto_paused';
      reason:
        | 'workflow_not_active'
        | 'workflow_definition_invalid'
        | 'principal_invalid'
        | 'access_denied'
        | 'mcp_readiness_failed'
        | 'model_not_allowed';
      error: string;
    }
  | {
      outcome: 'dispatched';
      executionId: string;
      runId: string;
      waitingForApproval: boolean;
      runtimeSubject: { userId: string; role: string };
    };

export function sanitizeWorkflowTriggerError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown workflow trigger dispatch failure';
  return message.slice(0, 240);
}

export async function dispatchWorkflowTrigger(
  trigger: WorkflowTriggerDispatchInput
): Promise<WorkflowTriggerDispatchResult> {
  const existing = await getWorkflowExecutionByTriggerOccurrence(
    trigger.workspaceId,
    trigger.id,
    trigger.occurrenceKey
  );
  if (existing) {
    return {
      outcome: 'dispatched',
      executionId: existing.execution.id,
      runId: existing.run.id,
      waitingForApproval: existing.run.status === 'waiting_for_approval',
      runtimeSubject: {
        userId: existing.compiledAccessScope.actor.userId,
        role: existing.compiledAccessScope.actor.role
      }
    };
  }

  const workflow = await getWorkflowDefinition(trigger.workspaceId, trigger.workflowId);
  if (!workflow || workflow.status !== 'active') {
    return {
      outcome: 'auto_paused',
      reason: 'workflow_not_active',
      error: 'Workflow is not active.'
    };
  }
  const runtimeSubject = await resolveRunPrincipal(trigger.workspaceId, trigger.principal);
  if (!runtimeSubject) {
    return {
      outcome: 'auto_paused',
      reason: 'principal_invalid',
      error: 'Delegated principal is no longer authorized.'
    };
  }

  const messageId = randomUUID();
  const sessionId = randomUUID();
  let compiledAccessScope;
  let sessionAccessScope;
  let specialistAgent: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>> | undefined;
  let resolution;

  try {
    resolution = await compileWorkflowPrompt({
      workflow,
      actorUserId: runtimeSubject.userId,
      initiatingMessageId: messageId,
      source: 'trigger'
    });
    const readiness = await computeWorkflowReadiness(workflow);
    if (readiness.status !== 'ready') {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
        readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.'
      );
    }
    const selectedAgents = (await Promise.all(workflow.agentIds.map((agentId) => (
      getAgentDefinition(trigger.workspaceId, agentId)
    )))).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
    specialistAgent = workflow.executionMode === 'direct' ? selectedAgents[0] : undefined;
    const mappings = await listCapabilityRoutingMappings(trigger.workspaceId, {
      activeReviewedOnly: true,
      capabilityIds: [...new Set(selectedAgents.flatMap((agent) => agent.semanticCapabilityIds))]
    });
    sessionAccessScope = compileWorkflowSessionCeiling({
      workflow,
      selectedAgents,
      specialistAgent,
      mappings,
      actor: runtimeSubject,
      principal: trigger.principal,
      approvedContextGrants: trigger.approvedContextGrants
    });
    compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      selectedAgents,
      specialistAgent,
      mappings,
      actor: runtimeSubject,
      principal: trigger.principal,
      approvedContextGrants: trigger.approvedContextGrants,
      resourceBindings: resolution.bindings,
      promptDigest: resolution.promptDigest,
      bindingDigest: resolution.bindingDigest
    });
  } catch (error) {
    if (
      error instanceof WorkflowAccessDeniedError
      || error instanceof PromptResourceProviderError
      || error instanceof WorkflowPromptValidationError
    ) {
      return {
        outcome: 'auto_paused',
        reason: error instanceof WorkflowPromptValidationError
          ? 'workflow_definition_invalid'
          : 'access_denied',
        error: sanitizeWorkflowTriggerError(error)
      };
    }
    throw error;
  }

  const mcpReadinessErrors = await getWorkflowCapabilityReadinessErrors(
    trigger.workspaceId,
    compiledAccessScope,
    { principal: trigger.principal }
  );
  if (mcpReadinessErrors.length > 0) {
    return {
      outcome: 'auto_paused',
      reason: 'mcp_readiness_failed',
      error: sanitizeWorkflowTriggerError(new Error(mcpReadinessErrors[0]))
    };
  }

  const aiSettings = await resolveWorkspaceLlmSettings(trigger.workspaceId);
  if (!isModelAllowedForProvider(aiSettings.provider, aiSettings.model)) {
    return {
      outcome: 'auto_paused',
      reason: 'model_not_allowed',
      error: 'Workspace AI model is not allowed.'
    };
  }

  const session = await createWorkflowSession({
    workflow,
    createdBy: runtimeSubject.userId,
    compiledAccessScope: sessionAccessScope,
    sessionId
  });
  const { execution, run, initialEvents } = await createWorkflowExecution({
    workflow,
    session,
    compiledAccessScope,
    messageId,
    content: resolution.content,
    triggerType: trigger.triggerType,
    triggerId: trigger.id,
    occurrenceKey: trigger.occurrenceKey,
    origin: trigger.triggerType === 'schedule'
      ? {
          schemaVersion: 1,
          kind: 'schedule',
          label: trigger.name,
          scheduleId: trigger.id
        }
      : {
          schemaVersion: 1,
          kind: 'webhook',
          label: trigger.name,
          webhookId: trigger.id
        },
    promptDigest: resolution.promptDigest,
    bindingDigest: resolution.bindingDigest,
    resourceBindings: resolution.bindings,
    resolvedAt: resolution.resolvedAt,
    markSessionLaunched: true,
    specialistSnapshot: specialistAgent,
    llmProvider: aiSettings.provider,
    llmModel: aiSettings.model,
    llmReasoningSummaryMode: aiSettings.reasoning.summary_mode,
    llmReasoningEffort: aiSettings.reasoning.effort,
  });
  emitWorkflowExecutionEvents(execution.id, initialEvents);
  return {
    outcome: 'dispatched',
    executionId: run.executionId,
    runId: run.id,
    waitingForApproval: run.status === 'waiting_for_approval',
    runtimeSubject: { userId: runtimeSubject.userId, role: runtimeSubject.role }
  };
}
