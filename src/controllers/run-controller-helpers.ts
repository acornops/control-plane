import type { Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { dispatchRunToExecutionEngine } from '../services/execution-engine-client.js';
import { repo } from '../store/repository.js';
import { runtime } from '../store/runtime.js';
import {
  getWorkflowRun,
  listWorkflowRunApprovals,
  updateWorkflowRunIfStatus
} from '../store/repository-workflows.js';
import type { Run, RunEvent } from '../types/domain.js';

export async function getReplayRunEvents(runId: string): Promise<RunEvent[]> {
  return config.PERSIST_RUN_EVENTS
    ? repo.getRunEvents(runId)
    : runtime.getRunEvents(runId) as RunEvent[];
}

export function writeSseRunEvent(res: Response, event: RunEvent): void {
  const eventType = typeof event.type === 'string' ? event.type : undefined;
  if (eventType) res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function redispatchWaitingRunAfterApproval(run: Run): void {
  if (run.status !== 'waiting_for_approval') return;
  queueMicrotask(async () => {
    try {
      const latest = await repo.getRun(run.id);
      if (!latest || latest.status !== 'waiting_for_approval') return;
      const current = (await repo.updateRun(run.id, { status: 'dispatching' })) || latest;
      await dispatchRunToExecutionEngine({ ...current, status: 'dispatching' });
    } catch (err) {
      logger.error({ err, runId: run.id }, 'Failed redispatching run after approval decision');
    }
  });
}

export function dispatchWorkflowRunAfterApprovals(runId: string): void {
  queueMicrotask(async () => {
    const run = await getWorkflowRun(runId);
    if (!run || run.status !== 'waiting_for_approval') return;
    const approvals = await listWorkflowRunApprovals(run.id);
    if (approvals.some((approval) => approval.status === 'pending')) return;
    if (approvals.some((approval) => approval.status === 'rejected' || approval.status === 'expired')) {
      await updateWorkflowRunIfStatus(run.id, ['waiting_for_approval'], {
        status: 'failed',
        errorCode: 'WORKFLOW_APPROVAL_NOT_GRANTED',
        errorMessage: 'Workflow approval gate was not granted.',
        endedAt: new Date().toISOString()
      });
      return;
    }
    await updateWorkflowRunIfStatus(run.id, ['waiting_for_approval'], { status: 'queued' });
  });
}
