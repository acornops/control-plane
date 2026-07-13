import { dispatchRunToExecutionEngine } from './execution-engine-client.js';
import { logger } from '../logger.js';
import { repo } from '../store/repository.js';
import { recordApprovalActivity } from './target-chat-activity-events.js';
import {
  applyAutomationApprovalOutcome,
  expirePendingAutomationRunApprovals
} from '../store/repository-automation-approvals.js';
import { incrementAutomationApproval } from '../metrics.js';

export async function expireAndResumeTimedOutApprovals(limit = 100): Promise<number> {
  const [expired, expiredAutomation] = await Promise.all([
    repo.expirePendingRunToolApprovals(limit),
    expirePendingAutomationRunApprovals(limit)
  ]);
  let resumed = 0;
  for (const approval of expired) {
    const run = await repo.getRun(approval.runId);
    if (run) {
      await recordApprovalActivity(approval, 'approval.expired', run.sessionId, run.messageId);
    }
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
  for (const approval of expiredAutomation) {
    await applyAutomationApprovalOutcome(approval);
    incrementAutomationApproval(approval.approvalKind, 'expired');
  }
  return resumed;
}
