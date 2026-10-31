import { canonicalJsonSha256 } from '../services/canonical-json.js';
import type { TargetIssueObservationInput } from '../services/target-issue-derivation.js';
import { withTransaction } from './repository-transaction.js';

export function observationSignature(observations: TargetIssueObservationInput[]): string {
  // Snapshot timestamps, finding IDs, text and counters change without a new
  // condition. Retain the set of conditions and affected evidence sources.
  const conditions = observations.map(observation => canonicalJsonSha256([
    observation.issueType, observation.severity, observation.reason,
    observation.scopeKind, observation.scopeName, observation.objectKind, observation.objectName,
    observation.evidence.source ?? null, observation.evidence.podName ?? null,
    observation.evidence.containerName ?? null
  ]));
  return canonicalJsonSha256([...new Set(conditions)].sort());
}

export async function purgeOldTargetIssueObservations(retentionDays: number, limit = 500): Promise<number> {
  return withTransaction(async client => {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(
      `WITH expired AS (
         SELECT id FROM target_issue_observations
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY created_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM target_issue_observations o USING expired
       WHERE o.id = expired.id`,
      [Math.max(1, retentionDays), Math.max(1, Math.min(500, limit))]
    );
    return result.rowCount ?? 0;
  });
}
