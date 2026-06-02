import { repo } from '../store/repository.js';
import { WorkspaceAuditEventInput } from '../types/domain.js';
import { logger } from '../logger.js';

export async function recordWorkspaceAuditEvent(input: WorkspaceAuditEventInput): Promise<void> {
  try {
    await repo.insertWorkspaceAuditEvent(input);
  } catch (err) {
    logger.warn(
      {
        err,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        targetType: input.targetType,
        targetId: input.targetId || null
      },
      'Failed recording workspace audit event'
    );
  }
}
