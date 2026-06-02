import { Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { logger } from '../logger.js';
import { incrementAdminAuditWriteFailures } from '../metrics.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { Run } from '../types/domain.js';

function requestId(req: AdminAuthenticatedRequest): string {
  return String(req.res?.locals?.requestId || '');
}

function sourceIp(req: AdminAuthenticatedRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function userAgent(req: AdminAuthenticatedRequest): string | null {
  const header = req.header('user-agent');
  return header ? header.slice(0, 512) : null;
}

export async function auditAdmin(req: AdminAuthenticatedRequest, input: {
  action: string;
  outcome?: 'success' | 'failure';
  workspaceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await repo.insertAdminAuditEvent({
      adminTokenId: req.admin.tokenId,
      outcome: input.outcome || 'success',
      requestId: requestId(req),
      sourceIp: sourceIp(req),
      userAgent: userAgent(req),
      ...input
    });
  } catch (err) {
    incrementAdminAuditWriteFailures();
    logger.error({ err, action: input.action, requestId: requestId(req) }, 'Failed recording admin audit event');
    throw err;
  }
}

export async function auditAdminMutationRequest(req: AdminAuthenticatedRequest, input: {
  action: string;
  workspaceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await auditAdmin(req, {
    ...input,
    action: `${input.action}.request`,
    metadata: { requestedAction: input.action, ...(input.metadata || {}) }
  });
}

export async function bestEffortWorkspaceAudit(input: {
  workspaceId: string;
  tokenId: string;
  category: 'membership' | 'workspace' | 'target' | 'run' | 'tool';
  eventType: string;
  targetType: string;
  targetId?: string | null;
  targetName?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: input.category,
    eventType: input.eventType,
    operation: 'write',
    actorType: 'admin_token',
    actorTokenId: input.tokenId,
    targetType: input.targetType,
    targetId: input.targetId,
    targetName: input.targetName,
    summary: input.summary,
    metadata: input.metadata
  });
}

export function validationError(res: Response, message: string, details?: Record<string, unknown>): void {
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, retryable: false, ...(details ? { details } : {}) } });
}

export function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message, retryable: false } });
}

export function parseBool(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
}

export function parseBoolQuery(value: unknown, name: string): { value?: boolean; error?: string } {
  const parsed = parseBool(value);
  if (value !== undefined && parsed === undefined) return { error: `${name} must be true or false` };
  return { value: parsed };
}

export function parseIsoDateQuery(value: unknown, name: string): { value?: string; error?: string } {
  if (value === undefined || value === '') return {};
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return { error: `${name} must be a valid date-time value` };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { error: `${name} must be a valid date-time value` };
  return { value: date.toISOString() };
}

export function parsePositiveIntQuery(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined || value === '') return {};
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return { error: `${name} must be a positive integer` };
  return { value: parsed };
}

export function parseStringFilter(value: unknown, name: string): { value?: string; error?: string } {
  if (value === undefined || value === '') return {};
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return { error: `${name} must be a valid filter value` };
  const trimmed = raw.trim();
  if (!trimmed) return { error: `${name} must not be blank` };
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { error: `${name} must be a valid filter value` };
  }
  return { value: trimmed };
}

export function activeRun(status: Run['status']): boolean {
  return !['completed', 'failed', 'cancelled'].includes(status);
}

export function safeRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    targetId: run.targetId,
    targetType: run.targetType,
    sessionId: run.sessionId,
    messageId: run.messageId,
    toolAccessMode: run.toolAccessMode,
    status: run.status,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    usage: run.usage
  };
}
