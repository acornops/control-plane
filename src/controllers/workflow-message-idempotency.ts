import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { getWorkflowExecutionByClientRequestId, type WorkflowSessionRecord } from '../store/repository-workflows.js';

export function isWorkflowClientRequestIdConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const databaseError = err as { code?: unknown; constraint?: unknown };
  return databaseError.code === '23505'
    && databaseError.constraint === 'workflow_executions_workspace_id_client_request_id_key';
}

export async function respondToWorkflowMessageRetry(
  res: Response,
  session: WorkflowSessionRecord,
  clientRequestId: string
): Promise<boolean> {
  if (!clientRequestId) return false;
  const existing = await getWorkflowExecutionByClientRequestId(session.workspaceId, clientRequestId);
  if (!existing) return false;
  if (existing.execution.workflowSessionId !== session.id) {
    res.status(409).json({
      error: {
        code: 'WORKFLOW_CLIENT_REQUEST_ID_CONFLICT',
        message: 'clientRequestId was already used for a different Workflow session.',
        retryable: false
      }
    });
    return true;
  }
  res.status(202).json({
    message_id: existing.message.id,
    run_id: existing.run.id,
    executionId: existing.execution.id,
    status: existing.run.status
  });
  return true;
}

export function workflowClientRequestId(
  req: AuthenticatedRequest,
  res: Response
): string | null {
  const id = typeof req.body.clientRequestId === 'string' ? req.body.clientRequestId.trim() : '';
  if (req.auth.credential?.type === 'external_integration' && !id) {
    res.status(400).json({
      error: {
        code: 'WORKFLOW_CLIENT_REQUEST_ID_REQUIRED',
        message: 'clientRequestId is required for external integration Workflow messages.',
        retryable: false
      }
    });
    return null;
  }
  if (id.length <= 128) return id;
  res.status(400).json({
    error: {
      code: 'WORKFLOW_CLIENT_REQUEST_ID_INVALID',
      message: 'clientRequestId must be at most 128 characters.',
      retryable: false
    }
  });
  return null;
}
