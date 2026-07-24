import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { canonicalJson } from '../services/canonical-json.js';
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
  clientRequestId: string,
  clientRequestFingerprint: string
): Promise<boolean> {
  if (!clientRequestId) return false;
  const existing = await getWorkflowExecutionByClientRequestId(session.workspaceId, clientRequestId);
  if (!existing) return false;
  if (existing.execution.workflowSessionId !== session.id
    || existing.execution.clientRequestFingerprint !== clientRequestFingerprint) {
    res.status(409).json({
      error: {
        code: 'WORKFLOW_CLIENT_REQUEST_ID_CONFLICT',
        message: 'clientRequestId was already used for a different Workflow request.',
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

export function workflowMessageRequestFingerprint(
  body: Record<string, unknown>
): string {
  const request = body.kind === 'launch'
    ? { kind: 'launch', inputs: body.inputs }
    : { kind: 'follow_up', content: body.content };
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

export function workflowClientRequestId(
  req: AuthenticatedRequest,
  res: Response
): string | null {
  const body = req.body && typeof req.body === 'object'
    ? req.body as Record<string, unknown>
    : {};
  const supplied = Object.prototype.hasOwnProperty.call(body, 'clientRequestId');
  if (supplied && typeof body.clientRequestId !== 'string') {
    res.status(400).json({
      error: {
        code: 'WORKFLOW_CLIENT_REQUEST_ID_INVALID',
        message: 'clientRequestId must be a non-empty string of at most 128 characters.',
        retryable: false
      }
    });
    return null;
  }
  const id = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
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
  if (!supplied || (id.length > 0 && id.length <= 128)) return id;
  res.status(400).json({
    error: {
      code: 'WORKFLOW_CLIENT_REQUEST_ID_INVALID',
      message: 'clientRequestId must be a non-empty string of at most 128 characters.',
      retryable: false
    }
  });
  return null;
}
