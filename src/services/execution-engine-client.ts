import { config } from '../config.js';
import { logger } from '../logger.js';
import { WorkflowRunRecord } from '../store/repository-workflows.js';
import { Run } from '../types/domain.js';
import { internalFetch } from './internal-http-client.js';

export async function dispatchRunToExecutionEngine(run: Run): Promise<void> {
  const payload = {
    contract_version: 1,
    run_id: run.id,
    workspace_id: run.workspaceId,
    target_id: run.targetId,
    target_type: run.targetType,
    session_id: run.sessionId,
    message_id: run.messageId,
    requested_at: run.requestedAt
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EXECUTION_ENGINE_TIMEOUT_MS);

  try {
    const response = await internalFetch(`${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.EXECUTION_ENGINE_DISPATCH_TOKEN}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    }, config.EXECUTION_ENGINE_TIMEOUT_MS);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Execution Engine start failed (${response.status}): ${body}`);
    }
  } catch (error) {
    logger.error({ err: error, runId: run.id }, 'Failed to dispatch run to execution engine');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function dispatchWorkflowRunToExecutionEngine(run: WorkflowRunRecord): Promise<void> {
  const payload = {
    contract_version: 1,
    scope_type: 'workspace',
    run_id: run.id,
    workspace_id: run.workspaceId,
    session_id: run.workflowSessionId,
    message_id: run.messageId,
    workflow_id: run.workflowId,
    workflow_run_id: run.workflowRunId,
    workflow_session_id: run.workflowSessionId,
    ...(run.workflowStepId ? { workflow_step_id: run.workflowStepId } : {}),
    requested_at: run.requestedAt
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.EXECUTION_ENGINE_TIMEOUT_MS);

  try {
    const response = await internalFetch(`${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.EXECUTION_ENGINE_DISPATCH_TOKEN}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    }, config.EXECUTION_ENGINE_TIMEOUT_MS);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Execution Engine workflow start failed (${response.status}): ${body}`);
    }
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
