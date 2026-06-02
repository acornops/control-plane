import { dispatchRunToExecutionEngine } from './execution-engine-client.js';
import { logger } from '../logger.js';
import { repo } from '../store/repository.js';

export async function expireAndResumeTimedOutApprovals(limit = 100): Promise<number> {
  const expired = await repo.expirePendingRunToolApprovals(limit);
  let resumed = 0;
  for (const approval of expired) {
    const run = await repo.getRun(approval.runId);
    if (!run || run.status !== 'waiting_for_approval') {
      continue;
    }
    try {
      const dispatching = (await repo.updateRun(run.id, { status: 'dispatching' })) || run;
      await dispatchRunToExecutionEngine(dispatching);
      resumed += 1;
    } catch (err) {
      logger.warn({ err, runId: approval.runId, approvalId: approval.id }, 'Failed redispatching expired approval');
    }
  }
  return resumed;
}
