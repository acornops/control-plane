import { deferConversationDispatch } from '../store/repository-conversation-dispatch.js';
import { withTransaction } from '../store/repository-transaction.js';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceCapacityError } from '../store/repository-run-capacity.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { WorkflowRunRecord } from '../store/repository-workflows.js';
import { Run } from '../types/domain.js';
import { internalFetch } from './internal-http-client.js';
import { workflowRunAgentClaims } from './workflow-run-agent-claims.js';


export class ExecutionEngineDrainingError extends Error {}

async function dispatch(payload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const response = await internalFetch(`${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.EXECUTION_ENGINE_DISPATCH_TOKEN}` },
      body: JSON.stringify(payload), signal
    }, config.EXECUTION_ENGINE_TIMEOUT_MS);
    if (response.ok) return;
    const body = await response.text();
    let error: { code?: unknown; retryable?: unknown; outcome?: unknown } | undefined;
    try { error = (JSON.parse(body) as { error?: typeof error }).error; } catch { /* Non-JSON errors cannot authorize replay. */ }
    if (response.status !== 503 || error?.code !== 'SERVICE_DRAINING' || error.retryable !== true || error.outcome !== 'not_started') {
      throw new Error(`Execution Engine start failed (${response.status}): ${body}`);
    }
    try { await delay(250, undefined, { signal }); }
    catch { throw new ExecutionEngineDrainingError('Execution engine is draining; dispatch was not started'); }
  }
  throw new ExecutionEngineDrainingError('Execution engine is draining; dispatch was not started');
}

export async function dispatchRunToExecutionEngine(run: Run, options: { deferOnDrain?: boolean } = {}): Promise<void> {
  if (run.conversationKind === 'agent_chat' && !run.agentId) {
    throw new Error('Agent-chat dispatch requires an Agent identity');
  }
  if (run.conversationKind === 'target_chat' && (!run.targetId || !run.targetType)) {
    throw new Error('Target-chat dispatch requires a target identity and type');
  }
  if (!config.WORKSPACE_DISPATCH_ENABLED) throw new WorkspaceCapacityError('WORKSPACE_DISPATCH_PAUSED', 'Execution dispatch is paused', 503);
  const payload = {
    contract_version: 2,
    capacity_contract_version: 1,
    capacity_enabled: config.WORKSPACE_CAPACITY_ENABLED,
    ...(run.conversationKind === 'agent_chat'
      ? { scope_type: 'agent_chat', agent_id: run.agentId }
      : { scope_type: 'target', target_id: run.targetId, target_type: run.targetType }),
    run_id: run.id,
    workspace_id: run.workspaceId,
    session_id: run.sessionId,
    message_id: run.messageId,
    requested_at: run.requestedAt
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EXECUTION_ENGINE_TIMEOUT_MS);

  try {
    await dispatch(payload, controller.signal);
  } catch (error) {
    if (error instanceof ExecutionEngineDrainingError && options.deferOnDrain) {
      await withTransaction((client) => deferConversationDispatch(client, run.id));
      return;
    }
    logger.error({ err: error, runId: run.id }, 'Failed to dispatch run to execution engine');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function dispatchWorkflowRunToExecutionEngine(run: WorkflowRunRecord): Promise<void> {
  const agentClaims = workflowRunAgentClaims(run);
  if (!config.WORKSPACE_DISPATCH_ENABLED) throw new WorkspaceCapacityError('WORKSPACE_DISPATCH_PAUSED', 'Execution dispatch is paused', 503);
  const payload = {
    contract_version: 2,
    capacity_contract_version: 1,
    capacity_enabled: config.WORKSPACE_CAPACITY_ENABLED,
    scope_type: 'workspace',
    run_id: run.id,
    workspace_id: run.workspaceId,
    session_id: run.workflowSessionId,
    message_id: run.messageId,
    workflow_id: run.workflowId,
    execution_id: run.executionId,
    workflow_session_id: run.workflowSessionId,
    executor_role: run.executorRole,
    ...(run.parentRunId ? { parent_run_id: run.parentRunId } : {}),
    attempt_number: run.attemptNumber,
    idempotency_key: run.idempotencyKey,
    ...(agentClaims.agentId ? { agent_id: agentClaims.agentId } : {}),
    ...(agentClaims.triggerId ? { trigger_id: agentClaims.triggerId } : {}),
    requested_at: run.requestedAt
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EXECUTION_ENGINE_TIMEOUT_MS);

  try {
    await dispatch(payload, controller.signal);
  } catch (error) {
    logger.error({ err: error, runId: run.id, workflowId: run.workflowId }, 'Failed to dispatch workflow run to execution engine');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function cancelRunInExecutionEngine(runId: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EXECUTION_ENGINE_TIMEOUT_MS);

  try {
    const response = await internalFetch(`${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.EXECUTION_ENGINE_DISPATCH_TOKEN}`
      },
      signal: controller.signal
    }, config.EXECUTION_ENGINE_TIMEOUT_MS);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Execution Engine cancel failed (${response.status}): ${body}`);
    }
  } catch (error) {
    logger.error({ err: error, runId }, 'Failed to cancel run in execution engine');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
