import { logger } from '../../logger.js';
import { repo } from '../../store/repository.js';

export async function requeuePausedKnowledgeBankCheckpoints(input: {
  workspaceId: string;
  targetId?: string;
  reason: string;
}): Promise<void> {
  try {
    const requeued = await repo.requeueKnowledgeBankPausedCheckpoints(input.workspaceId, input.targetId);
    if (requeued > 0) {
      logger.info({
        workspaceId: input.workspaceId,
        targetId: input.targetId || null,
        requeued,
        reason: input.reason
      }, 'Requeued paused Knowledge Bank checkpoints');
    }
  } catch (err) {
    logger.warn({
      err,
      workspaceId: input.workspaceId,
      targetId: input.targetId || null,
      reason: input.reason
    }, 'Failed requeueing paused Knowledge Bank checkpoints');
  }
}
