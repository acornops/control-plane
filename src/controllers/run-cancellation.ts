import { logger } from '../logger.js';
import { publishRunEvents } from '../services/control-plane-coordination.js';
import { emitRunStatusTransition } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { runtime } from '../store/runtime.js';
import { Run, RunEvent } from '../types/domain.js';
import { config } from '../config.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isRunTerminalStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

async function getLatestRunEventSeq(runId: string): Promise<number> {
  if (config.PERSIST_RUN_EVENTS) {
    return repo.getLatestRunEventSeq(runId);
  }
  return Math.max(0, ...runtime.getRunEvents(runId).map((event) => event.seq));
}

async function hasRunCancelledEvent(runId: string): Promise<boolean> {
  const events = config.PERSIST_RUN_EVENTS
    ? await repo.getRunEvents(runId)
    : runtime.getRunEvents(runId);
  return events.some((event) => event.type === 'run_cancelled');
}

async function appendAndPublishRunCancelledEvent(run: Run): Promise<void> {
  if (await hasRunCancelledEvent(run.id)) {
    return;
  }
  const latestSeq = await getLatestRunEventSeq(run.id);
  const event: RunEvent = {
    schema_version: 1,
    run_id: run.id,
    seq: latestSeq + 1,
    ts: new Date().toISOString(),
    type: 'run_cancelled',
    payload: { reason: 'user_cancelled' }
  };
  const accepted = await repo.appendRunEvents(run.id, [event]);
  const buffered = runtime.appendRunEvents(run.id, accepted);
  for (const bufferedEvent of buffered) {
    runtime.runStreams.emit(`run:${run.id}`, { event: bufferedEvent });
  }
  publishRunEvents(run.id, buffered).catch((err) => {
    logger.warn({ err, runId: run.id }, 'Failed publishing distributed run cancellation event');
  });
}

export async function terminalizeRunCancellation(run: Run): Promise<Run | null> {
  if (isRunTerminalStatus(run.status)) {
    return run;
  }

  if (run.status === 'waiting_for_approval') {
    const continuation = await repo.getRunContinuation(run.id);
    if (continuation) {
      await repo.expireRunToolApproval(continuation.approvalId);
      await repo.deleteRunContinuation(run.id);
    }
  }

  const cancelledRun = await repo.updateRun(run.id, {
    status: 'cancelled',
    endedAt: new Date().toISOString()
  });
  if (!cancelledRun) {
    return null;
  }
  emitRunStatusTransition(run, cancelledRun);
  await appendAndPublishRunCancelledEvent(cancelledRun);
  return cancelledRun;
}
