import {
  incrementTargetInsightsCheckpointOutcome,
  recordTargetInsightsCheckpointPatchCount
} from '../../metrics.js';
import { repo } from '../../store/repository.js';
import type { TargetInsightsCheckpointJob } from '../../store/repository-target-insights-checkpoints.js';
import { withTransaction } from '../../store/repository-transaction.js';
import { recordTargetInsightsAudit } from './audit.js';
import type {
  TargetInsightsCheckpointResponseReason,
  TargetInsightsNoopReasonCode
} from './checkpoint-response.js';

type CheckpointTerminalOutcome =
  | { kind: 'noop'; reasonCode: TargetInsightsNoopReasonCode; proposedPatchCount: 1 }
  | { kind: 'invalid_response'; reasonCode: TargetInsightsCheckpointResponseReason; proposedPatchCount: number }
  | { kind: 'provider_failure'; reasonCode: 'provider_failure'; proposedPatchCount: 0 };

const outcomeAudit = {
  noop: {
    eventType: 'target_insights.checkpoint.noop.v1',
    summary: 'Target Insights checkpoint found no durable learning'
  },
  invalid_response: {
    eventType: 'target_insights.checkpoint.invalid_response.v1',
    summary: 'Target Insights checkpoint returned an invalid response'
  },
  provider_failure: {
    eventType: 'target_insights.checkpoint.failed.v1',
    summary: 'Target Insights checkpoint provider request failed'
  }
} as const;

function jobKey(job: TargetInsightsCheckpointJob) {
  return {
    workspaceId: job.workspaceId,
    targetId: job.targetId,
    sessionId: job.sessionId,
    lastActivityAt: job.lastActivityAt,
    leaseOwner: job.leaseOwner
  };
}

async function finishCurrentJob(
  job: TargetInsightsCheckpointJob,
  outcome: CheckpointTerminalOutcome
): Promise<boolean> {
  const status = outcome.kind === 'noop' ? 'noop' : 'failed';
  const retryAfter = outcome.kind === 'provider_failure'
    ? new Date(Date.now() + 15 * 60_000).toISOString()
    : undefined;
  return withTransaction(async (client) => {
    if (!(await repo.renewTargetInsightsCheckpointJobLeaseIfCurrent(jobKey(job), client))) return false;
    const finished = await repo.finishTargetInsightsCheckpointJob({
      ...jobKey(job),
      status,
      error: outcome.kind === 'noop' ? null : outcome.reasonCode,
      retryAfter
    }, client);
    if (!finished) throw new Error('Target Insights checkpoint lease expired before finish');
    return true;
  });
}

export async function completeTargetInsightsCheckpoint(
  job: TargetInsightsCheckpointJob,
  model: { provider: string; model: string },
  outcome: CheckpointTerminalOutcome
): Promise<boolean> {
  if (!(await finishCurrentJob(job, outcome))) return false;

  const status = outcome.kind === 'noop' ? 'noop' : 'failed';
  incrementTargetInsightsCheckpointOutcome(status, outcome.reasonCode);
  recordTargetInsightsCheckpointPatchCount(status, 0);
  await recordTargetInsightsAudit({
    workspaceId: job.workspaceId,
    targetId: job.targetId,
    targetType: job.targetType,
    actorType: 'system',
    eventType: outcomeAudit[outcome.kind].eventType,
    objectId: job.targetId,
    summary: outcomeAudit[outcome.kind].summary,
    metadata: {
      outcome: outcome.kind,
      reasonCode: outcome.reasonCode,
      provider: model.provider,
      model: model.model,
      sessionId: job.sessionId,
      proposedPatchCount: outcome.proposedPatchCount,
      appliedPatchCount: 0,
      rejectedPatchCount: outcome.kind === 'invalid_response' ? outcome.proposedPatchCount : 0
    }
  });
  return true;
}

export async function rescheduleTargetInsightsCheckpointAfterStateChange(
  job: TargetInsightsCheckpointJob
): Promise<void> {
  await repo.rescheduleTargetInsightsCheckpointJob({
    ...jobKey(job),
    dueAt: new Date(Date.now() + 60_000).toISOString(),
    error: 'state_changed'
  });
  incrementTargetInsightsCheckpointOutcome('skipped', 'state_changed');
}
