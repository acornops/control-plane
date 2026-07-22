import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { repo } from '../store/repository.js';

export function hashOidcSubject(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

export async function recordAuthAudit(input: {
  eventType: string;
  summary: string;
  userId?: string;
  provider?: string;
  issuer?: string;
  subject?: string;
  reason?: string;
}): Promise<void> {
  const metadata = {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.issuer ? { issuer: input.issuer } : {}),
    ...(input.subject ? { subjectHash: hashOidcSubject(input.subject) } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  };
  logger.info({
    eventType: input.eventType,
    ...(input.userId ? { userId: input.userId } : {}),
    ...metadata
  }, input.summary);
  try {
    await repo.insertAccountAuditEvent({
      userId: input.userId,
      category: 'auth',
      eventType: input.eventType,
      operation: 'write',
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      objectType: 'authentication_session',
      objectId: input.subject ? hashOidcSubject(input.subject) : undefined,
      summary: input.summary,
      metadata
    });
  } catch (err) {
    logger.warn({ err, eventType: input.eventType }, 'Failed recording account authentication audit event');
  }
}
