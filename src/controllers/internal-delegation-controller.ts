import type { NextFunction, Request, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { observeWorkflowDelegationOutcome } from '../metrics.js';
import {
  DEFAULT_MAX_CONCURRENT_DELEGATIONS,
  DEFAULT_MAX_DELEGATIONS
} from '../services/coordination-functions.js';
import { promptResourceRegistry } from '../services/prompt-resources/index.js';
import {
  compileWorkflowAccessScope,
  selectDelegationCandidate
} from '../services/workflow-access.js';
import { getExactMcpReadinessErrors } from '../services/workflow-readiness.js';
import {
  createDelegatedWorkflowRun,
  getWorkflowSession,
  getWorkflowRun,
  listWorkflowChildRuns
} from '../store/repository-workflows.js';
import { WorkflowDelegationConflictError } from '../store/repository-workflow-run-delegations.js';
import type { TargetType } from '../types/domain.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';

const MAX_COORDINATOR_CHILD_RESULT_CHARS = 12_000;
const MAX_COORDINATOR_CHILD_ERROR_CHARS = 500;

export function boundedCoordinatorChildResult(
  assistantMessage?: { content: string; format?: string }
): { content: string; format?: string } | undefined {
  return assistantMessage
    ? {
        ...assistantMessage,
        content: String(assistantMessage.content || '').slice(0, MAX_COORDINATOR_CHILD_RESULT_CHARS)
      }
    : undefined;
}

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

export async function delegateSpecialist(req: Request, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  try {
    const parent = await getWorkflowRun(toSingleParam(req.params.runId));
    if (!parent || parent.endedAt) {
      badRequest(res, 'DELEGATION_PARENT_UNAVAILABLE', 'The parent Workflow run is unavailable.');
      return;
    }
    if (parent.executorRole !== 'coordinator' || parent.parentRunId) {
      badRequest(res, 'DELEGATION_COORDINATOR_REQUIRED', 'Only a coordinator root may delegate.', 403);
      return;
    }
    const toolCallId = typeof req.body?.toolCallId === 'string' ? req.body.toolCallId.trim() : '';
    const capabilityId = typeof req.body?.capabilityId === 'string' ? req.body.capabilityId.trim() : '';
    const taskPrompt = typeof req.body?.taskPrompt === 'string' ? req.body.taskPrompt.trim() : '';
    const binding = req.body?.targetBinding as { id?: unknown; targetType?: unknown } | undefined;
    const targetId = typeof binding?.id === 'string' ? binding.id.trim() : '';
    const targetType = binding?.targetType;
    const required = req.body?.required !== false;
    if (!toolCallId || !capabilityId || !taskPrompt || !targetId
      || (targetType !== 'kubernetes' && targetType !== 'virtual_machine')) {
      badRequest(
        res,
        'DELEGATION_REQUEST_INVALID',
        'toolCallId, capabilityId, taskPrompt, and an exact targetBinding are required.',
        400
      );
      return;
    }
    const workflow = await pinnedWorkflow(parent.executionId);
    if (!workflow) {
      badRequest(res, 'DELEGATION_WORKFLOW_SNAPSHOT_MISSING', 'The pinned Workflow snapshot is unavailable.');
      return;
    }
    const session = await getWorkflowSession(parent.workflowSessionId);
    if (!session || session.workflowId !== parent.workflowId || session.workspaceId !== parent.workspaceId) {
      badRequest(res, 'DELEGATION_AUTHORIZATION_CEILING_MISSING', 'The pinned Workflow authorization ceiling is unavailable.');
      return;
    }
    const authorizationCeiling = session.compiledAccessScope;
    if (!authorizationCeiling.semanticCapabilityIds.includes(capabilityId)) {
      badRequest(res, 'DELEGATION_CAPABILITY_DENIED', 'The capability is outside the pinned Workflow scope.', 403);
      return;
    }
    if (!parent.prompt.trim()) {
      badRequest(res, 'DELEGATION_PROMPT_SNAPSHOT_MISSING', 'The exact parent prompt is unavailable.');
      return;
    }
    const targetGranted = parent.resourceBindings.some((resourceBinding) => {
      const projection = promptResourceRegistry.projectRuntime([resourceBinding], parent.id);
      const route = projection.targetRoute && typeof projection.targetRoute === 'object'
        ? projection.targetRoute as Record<string, unknown>
        : undefined;
      return route?.id === targetId && route.targetType === targetType;
    });
    if (!targetGranted) {
      badRequest(res, 'DELEGATION_TARGET_DENIED', 'The target is outside the pinned Workflow resources.', 403);
      return;
    }
    const target = await (await import('../store/repository.js')).repo.getTarget(parent.workspaceId, targetId);
    if (!target || target.status === 'offline' || target.targetType !== targetType) {
      badRequest(res, 'DELEGATION_TARGET_NOT_READY', 'The exact target is unavailable or incompatible.');
      return;
    }
    if (authorizationCeiling.principal.type === 'user') {
      const membership = await db.query(
        'SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
        [parent.workspaceId, authorizationCeiling.principal.id]
      );
      if (!membership.rowCount) {
        badRequest(res, 'DELEGATION_PRINCIPAL_DENIED', 'The pinned principal no longer has workspace access.', 403);
        return;
      }
    }

    const agents = authorizationCeiling.selectedAgentSnapshots;
    const mappings = authorizationCeiling.routingMappingSnapshots
      .filter((mapping) => mapping.capabilityId === capabilityId);
    const selected = selectDelegationCandidate({
      workflow,
      capabilityId,
      target: { id: targetId, targetType: targetType as TargetType },
      agents,
      mappings
    });
    if (!selected) {
      observeWorkflowDelegationOutcome('unavailable', Date.now() - startedAt);
      badRequest(res, 'DELEGATION_SPECIALIST_UNAVAILABLE', 'No eligible reviewed specialist can handle this capability and target.');
      return;
    }
    if (selected.mapping.contextGrants.some((grant) => !authorizationCeiling.contextGrants.includes(grant))) {
      badRequest(res, 'DELEGATION_CONTEXT_DENIED', 'The specialist requires context outside the parent scope.', 403);
      return;
    }
    const delegatedWorkflow: WorkflowDefinitionForAccess = {
      ...workflow,
      capabilityPolicy: {
        ...workflow.capabilityPolicy,
        restrictionMode: 'restrict',
        semanticCapabilityIds: [capabilityId]
      }
    };
    const compiledScope = compileWorkflowAccessScope({
      workflow: delegatedWorkflow,
      selectedAgents: agents,
      specialistAgent: selected.agent,
      delegatedSpecialist: true,
      mappings: [selected.mapping],
      actor: {
        userId: authorizationCeiling.actor.userId,
        role: authorizationCeiling.actor.role,
        permissions: Object.fromEntries(
          authorizationCeiling.requiredPermissions.map((permission) => [permission, true])
        ) as never
      },
      approvedContextGrants: authorizationCeiling.contextGrants,
      principal: authorizationCeiling.principal,
      targetRoute: { id: targetId, targetType: targetType as TargetType },
      resourceBindings: parent.resourceBindings,
      promptDigest: parent.promptDigest,
      bindingDigest: parent.bindingDigest
    });
    compiledScope.coordinationFunctions = [];
    const readinessErrors = await getExactMcpReadinessErrors(
      parent.workspaceId,
      compiledScope.principal,
      compiledScope.mcpTools
    );
    if (readinessErrors.length > 0) {
      badRequest(
        res,
        readinessErrors[0].startsWith('MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED')
          ? 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED'
          : 'MCP_CONNECTION_REQUIRED',
        readinessErrors[0]
      );
      return;
    }

    const child = await createDelegatedWorkflowRun({
      parent,
      specialist: selected.agent,
      compiledAccessScope: compiledScope,
      toolCallId,
      capabilityId,
      targetId,
      targetType: targetType as TargetType,
      taskPrompt,
      required,
      maxConcurrentChildren: DEFAULT_MAX_CONCURRENT_DELEGATIONS,
      maxChildren: DEFAULT_MAX_DELEGATIONS
    });
    observeWorkflowDelegationOutcome('selected', Date.now() - startedAt);
    res.status(child.created ? 201 : 200).json({
      childRunId: child.run.id,
      status: child.run.status,
      capabilityId,
      targetBinding: { id: targetId, targetType },
      selectedAgentId: selected.agent.id
    });
  } catch (error) {
    observeWorkflowDelegationOutcome('failed', Date.now() - startedAt);
    if (error instanceof WorkflowDelegationConflictError) {
      const messages = {
        DELEGATION_IDEMPOTENCY_CONFLICT: 'The tool-call ID was already used with a different delegation request.',
        DELEGATION_PARENT_INVALID: 'Delegation requires an active coordinator root.',
        DELEGATION_TOTAL_LIMIT: 'The coordinator reached its total child limit.',
        DELEGATION_CONCURRENCY_LIMIT: 'The coordinator reached its concurrent child limit.'
      } as const;
      badRequest(res, error.code, messages[error.code]);
      return;
    }
    next(error);
  }
}

export async function awaitDelegations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parent = await getWorkflowRun(toSingleParam(req.params.runId));
    if (!parent || parent.executorRole !== 'coordinator' || parent.parentRunId) {
      badRequest(res, 'DELEGATION_COORDINATOR_REQUIRED', 'Only a coordinator root may await delegations.', 403);
      return;
    }
    const children = await listWorkflowChildRuns(parent.id);
    const items = children.map((child) => ({
      childRunId: child.id,
      capabilityId: child.delegationCapabilityId,
      targetBinding: { id: child.targetId, targetType: child.targetType },
      required: child.delegationRequired,
      selectedAgentId: child.agentId,
      status: child.status,
      result: child.status === 'completed'
        ? boundedCoordinatorChildResult(child.assistantMessage)
        : undefined,
      errorCode: child.errorCode,
      errorMessage: child.errorMessage?.slice(0, MAX_COORDINATOR_CHILD_ERROR_CHARS)
    }));
    res.status(200).json({
      items,
      pending: children.filter((child) => (
        ['queued', 'dispatching', 'running', 'waiting_for_approval'].includes(child.status)
      )).length
    });
  } catch (error) {
    next(error);
  }
}
