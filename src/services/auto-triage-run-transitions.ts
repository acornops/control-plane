import type { Run } from '../types/domain.js';
import type { TargetAutoTriageJob } from '../types/auto-triage.js';
import { repo } from '../store/repository.js';
import { updateRunWhileStatus } from '../store/repository-runs.js';
import { withTransaction } from '../store/repository-transaction.js';

export async function updateLinkedRunWhileClaimed(
  job: TargetAutoTriageJob,
  run: Run,
  patch: Partial<Run>
): Promise<Run | null> {
  return withTransaction(async (client) => {
    const ownsLease = await repo.autoTriage.lockClaimedTargetAutoTriageJob(
      job.id,
      job.leaseOwner!,
      client
    );
    if (!ownsLease) return null;
    return updateRunWhileStatus(run.id, run.status, patch, client);
  });
}

export async function transitionLinkedRunWhileClaimed(
  job: TargetAutoTriageJob,
  run: Run,
  runPatch: Partial<Run>,
  jobPatch: Omit<
    Parameters<typeof repo.autoTriage.updateClaimedTargetAutoTriageJob>[0],
    'jobId' | 'leaseOwner'
  >
): Promise<Run | null> {
  return withTransaction(async (client) => {
    const ownsLease = await repo.autoTriage.lockClaimedTargetAutoTriageJob(
      job.id,
      job.leaseOwner!,
      client
    );
    if (!ownsLease) return null;
    const updatedRun = await updateRunWhileStatus(
      run.id,
      run.status,
      runPatch,
      client
    );
    if (!updatedRun) return null;
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner!,
      ...jobPatch
    }, client);
    if (!transitioned) {
      throw new Error(
        'Automatic investigation lease expired during a claimed transition'
      );
    }
    return updatedRun;
  });
}
