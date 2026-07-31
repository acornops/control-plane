import type { PoolClient } from 'pg';
import type { TargetIssue } from '../types/domain.js';
import {
  enqueueTargetAutoTriageJob,
  getTargetAutoTriageSettings
} from './repository-auto-triage.js';
import { issueMeetsAutoTriageEligibility } from '../utils/auto-triage-eligibility.js';

function severityRank(severity: TargetIssue['severity']): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

export async function enqueueAutoTriageForObservedIssue(
  client: PoolClient,
  issue: TargetIssue,
  previous?: { status: TargetIssue['status']; severity_rank: number } | null
): Promise<void> {
  const settings = await getTargetAutoTriageSettings(issue.workspaceId, issue.targetId, client);
  const crossedThreshold = Boolean(
    previous
    && previous.status !== 'resolved'
    && Number(previous.severity_rank) > severityRank(settings.minimumSeverity)
    && issueMeetsAutoTriageEligibility(issue, settings)
  );
  if (
    settings.enabled
    && issueMeetsAutoTriageEligibility(issue, settings)
    && (!previous || previous.status === 'resolved' || crossedThreshold)
  ) {
    await enqueueTargetAutoTriageJob(
      client,
      issue,
      !previous ? 'created' : previous.status === 'resolved' ? 'reopened' : 'severity_escalated',
      settings.revision
    );
  }
}
