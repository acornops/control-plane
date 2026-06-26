import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { TargetIssue, TargetIssueObservation, TargetIssueSeverity, TargetIssueStatus, TargetType } from '../types/domain.js';
import { containsSearchText, encodeCursor, pageWithCursor, PagedResult } from '../utils/pagination.js';
import { severityRank } from '../services/snapshot-derived-data.js';
import { TargetIssueObservationInput } from '../services/target-issue-derivation.js';
import { toIso } from './repository-mappers.js';

type QueryClient = Pick<PoolClient, 'query'>;

interface TargetIssueDbRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  target_name?: string;
  fingerprint: string;
  issue_type: string;
  status: TargetIssueStatus;
  severity: TargetIssueSeverity;
  severity_rank: number;
  title: string;
  summary: string;
  scope_kind: string | null;
  scope_name: string | null;
  object_kind: string | null;
  object_name: string | null;
  reason: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  last_observed_snapshot_at: Date | string;
  resolved_at: Date | string | null;
  occurrence_count: number | string;
  reopened_count: number | string;
  clean_snapshot_count: number | string;
  latest_evidence: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TargetIssueObservationDbRow {
  id: string;
  issue_id: string;
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  snapshot_ts: Date | string;
  finding_id: string | null;
  severity: TargetIssueSeverity;
  title: string;
  message: string;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  created_at: Date | string;
}

interface IssuePageCursor {
  statusRank: number;
  severityRank: number;
  lastSeenAt: string;
  issueId: string;
  signature?: string;
}

interface ObservationPageCursor {
  snapshotTs: string;
  observationId: string;
  signature?: string;
}

export type IssueStatusFilter = TargetIssueStatus | 'all';

function statusRank(status: TargetIssueStatus): number {
  if (status === 'active') return 0;
  if (status === 'recovering') return 1;
  return 2;
}

function mapIssueRow(row: TargetIssueDbRow): TargetIssue {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    targetName: row.target_name,
    fingerprint: row.fingerprint,
    issueType: row.issue_type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    scopeKind: row.scope_kind || undefined,
    scopeName: row.scope_name || undefined,
    namespace: row.scope_name || undefined,
    objectKind: row.object_kind || undefined,
    objectName: row.object_name || undefined,
    reason: row.reason || undefined,
    firstSeenAt: toIso(row.first_seen_at)!,
    lastSeenAt: toIso(row.last_seen_at)!,
    lastObservedSnapshotAt: toIso(row.last_observed_snapshot_at)!,
    resolvedAt: toIso(row.resolved_at),
    occurrenceCount: Number(row.occurrence_count),
    reopenedCount: Number(row.reopened_count),
    cleanSnapshotCount: Number(row.clean_snapshot_count),
    latestEvidence: row.latest_evidence || {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

function mapObservationRow(row: TargetIssueObservationDbRow): TargetIssueObservation {
  return {
    id: row.id,
    issueId: row.issue_id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    snapshotTs: toIso(row.snapshot_ts)!,
    findingId: row.finding_id || undefined,
    severity: row.severity,
    title: row.title,
    message: row.message,
    reason: row.reason || undefined,
    evidence: row.evidence || {},
    createdAt: toIso(row.created_at)!
  };
}

function chooseIssueObservation(observations: TargetIssueObservationInput[]): TargetIssueObservationInput {
  return [...observations].sort((left, right) =>
    severityRank(left.severity) - severityRank(right.severity) ||
    left.title.localeCompare(right.title)
  )[0];
}

function groupObservations(observations: TargetIssueObservationInput[]): Map<string, TargetIssueObservationInput[]> {
  const grouped = new Map<string, TargetIssueObservationInput[]>();
  for (const observation of observations) {
    const group = grouped.get(observation.fingerprint) || [];
    group.push(observation);
    grouped.set(observation.fingerprint, group);
  }
  return grouped;
}

function shouldResolveIssue(snapshotTs: string, lastSeenAt: Date | string, cleanSnapshotCount: number): boolean {
  const snapshotTime = Date.parse(snapshotTs);
  const lastSeenTime = Date.parse(toIso(lastSeenAt) || '');
  const missingForLongEnough = Number.isFinite(snapshotTime) && Number.isFinite(lastSeenTime) && snapshotTime - lastSeenTime >= 10 * 60 * 1000;
  return cleanSnapshotCount >= 3 || missingForLongEnough;
}

async function insertIssueObservation(
  client: QueryClient,
  issueId: string,
  observation: TargetIssueObservationInput
): Promise<void> {
  await client.query(
    `INSERT INTO target_issue_observations (
       id, issue_id, workspace_id, target_id, target_type, snapshot_ts, finding_id, severity,
       title, message, reason, evidence
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      randomUUID(),
      issueId,
      observation.workspaceId,
      observation.targetId,
      observation.targetType,
      observation.snapshotTs,
      observation.findingId,
      observation.severity,
      observation.title,
      observation.message,
      observation.reason,
      JSON.stringify(observation.evidence)
    ]
  );
}

async function upsertObservedIssue(
  client: QueryClient,
  observation: TargetIssueObservationInput
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO target_issues (
       id, workspace_id, target_id, target_type, fingerprint, issue_type, status, severity, severity_rank,
       title, summary, scope_kind, scope_name, object_kind, object_name, reason, first_seen_at, last_seen_at,
       last_observed_snapshot_at, resolved_at, occurrence_count, reopened_count, clean_snapshot_count,
       latest_evidence, search_text
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16,
       NULL, 1, 0, 0, $17::jsonb, $18)
     ON CONFLICT (target_id, fingerprint) DO UPDATE
     SET workspace_id = EXCLUDED.workspace_id,
         target_type = EXCLUDED.target_type,
         issue_type = EXCLUDED.issue_type,
         status = 'active',
         severity = EXCLUDED.severity,
         severity_rank = EXCLUDED.severity_rank,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         scope_kind = EXCLUDED.scope_kind,
         scope_name = EXCLUDED.scope_name,
         object_kind = EXCLUDED.object_kind,
         object_name = EXCLUDED.object_name,
         reason = EXCLUDED.reason,
         last_seen_at = EXCLUDED.last_seen_at,
         last_observed_snapshot_at = EXCLUDED.last_observed_snapshot_at,
         resolved_at = NULL,
         occurrence_count = target_issues.occurrence_count + 1,
         reopened_count = target_issues.reopened_count + CASE WHEN target_issues.status = 'resolved' THEN 1 ELSE 0 END,
         clean_snapshot_count = 0,
         latest_evidence = EXCLUDED.latest_evidence,
         search_text = EXCLUDED.search_text,
         updated_at = NOW()
     RETURNING id`,
    [
      randomUUID(),
      observation.workspaceId,
      observation.targetId,
      observation.targetType,
      observation.fingerprint,
      observation.issueType,
      observation.severity,
      severityRank(observation.severity),
      observation.title,
      observation.summary,
      observation.scopeKind,
      observation.scopeName,
      observation.objectKind,
      observation.objectName,
      observation.reason,
      observation.snapshotTs,
      JSON.stringify(observation.evidence),
      observation.searchText
    ]
  );
  return result.rows[0].id;
}

async function markUnobservedIssues(
  client: QueryClient,
  input: {
    targetId: string;
    snapshotTs: string;
    observedFingerprints: Set<string>;
  }
): Promise<void> {
  const existing = await client.query<Pick<TargetIssueDbRow, 'id' | 'fingerprint' | 'last_seen_at' | 'clean_snapshot_count'>>(
    `SELECT id, fingerprint, last_seen_at, clean_snapshot_count
     FROM target_issues
     WHERE target_id = $1 AND status IN ('active', 'recovering')`,
    [input.targetId]
  );
  for (const row of existing.rows) {
    if (input.observedFingerprints.has(row.fingerprint)) continue;
    const nextCleanCount = Number(row.clean_snapshot_count) + 1;
    const nextStatus: TargetIssueStatus = shouldResolveIssue(input.snapshotTs, row.last_seen_at, nextCleanCount)
      ? 'resolved'
      : 'recovering';
    await client.query(
      `UPDATE target_issues
       SET status = $2,
           clean_snapshot_count = $3,
           resolved_at = CASE WHEN $2 = 'resolved' THEN $4::timestamptz ELSE resolved_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, nextStatus, nextCleanCount, input.snapshotTs]
    );
  }
}

export async function reconcileTargetIssues(
  client: QueryClient,
  input: {
    targetId: string;
    snapshotTs: string;
    observations: TargetIssueObservationInput[];
  }
): Promise<void> {
  const grouped = groupObservations(input.observations);
  for (const observations of grouped.values()) {
    const issueObservation = chooseIssueObservation(observations);
    const issueId = await upsertObservedIssue(client, issueObservation);
    for (const observation of observations) {
      await insertIssueObservation(client, issueId, observation);
    }
  }
  await markUnobservedIssues(client, {
    targetId: input.targetId,
    snapshotTs: input.snapshotTs,
    observedFingerprints: new Set(grouped.keys())
  });
}

function appendIssueFilters(
  clauses: string[],
  params: Array<string | number>,
  options: {
    status?: IssueStatusFilter;
    severity?: string;
    targetType?: string;
    targetId?: string;
    namespace?: string;
    q?: string;
    cursor?: IssuePageCursor | null;
  }
): void {
  if (options.status && options.status !== 'all') {
    params.push(options.status);
    clauses.push(`i.status = $${params.length}`);
  } else if (!options.status) {
    clauses.push("i.status IN ('active', 'recovering')");
  }
  if (options.severity) {
    params.push(options.severity);
    clauses.push(`i.severity = $${params.length}`);
  }
  if (options.targetType) {
    params.push(options.targetType);
    clauses.push(`i.target_type = $${params.length}`);
  }
  if (options.targetId) {
    params.push(options.targetId);
    clauses.push(`i.target_id = $${params.length}`);
  }
  if (options.namespace) {
    params.push(options.namespace);
    clauses.push(`i.scope_name = $${params.length}`);
  }
  if (options.q) {
    params.push(`%${options.q.replace(/[\\%_]/g, '\\$&')}%`);
    clauses.push(`(i.search_text LIKE $${params.length} ESCAPE '\\' OR LOWER(t.name) LIKE $${params.length} ESCAPE '\\')`);
  }
  if (options.cursor) {
    params.push(options.cursor.statusRank, options.cursor.severityRank, options.cursor.lastSeenAt, options.cursor.issueId);
    clauses.push(
      `(CASE i.status WHEN 'active' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END > $${params.length - 3}
        OR (CASE i.status WHEN 'active' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END = $${params.length - 3}
          AND i.severity_rank > $${params.length - 2})
        OR (CASE i.status WHEN 'active' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END = $${params.length - 3}
          AND i.severity_rank = $${params.length - 2}
          AND i.last_seen_at < $${params.length - 1}::timestamptz)
        OR (CASE i.status WHEN 'active' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END = $${params.length - 3}
          AND i.severity_rank = $${params.length - 2}
          AND i.last_seen_at = $${params.length - 1}::timestamptz
          AND i.id > $${params.length}))`
    );
  }
}

async function listIssuesFromSql(
  where: string,
  params: Array<string | number>,
  limit: number,
  signature: string
): Promise<PagedResult<TargetIssue>> {
  params.push(limit + 1);
  const result = await db.query<TargetIssueDbRow>(
    `SELECT i.*, t.name AS target_name
     FROM target_issues i
     JOIN targets t ON t.id = i.target_id
     WHERE ${where}
     ORDER BY CASE i.status WHEN 'active' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END ASC,
       i.severity_rank ASC, i.last_seen_at DESC, i.id ASC
     LIMIT $${params.length}`,
    params
  );
  const page = pageWithCursor(result.rows, limit, (row) =>
    encodeCursor({
      signature,
      statusRank: statusRank(row.status),
      severityRank: row.severity_rank,
      lastSeenAt: toIso(row.last_seen_at),
      issueId: row.id
    })
  );
  return {
    items: page.items.map(mapIssueRow),
    nextCursor: page.nextCursor
  };
}

export async function listWorkspaceIssues(
  workspaceId: string,
  options: {
    limit: number;
    cursor?: (IssuePageCursor & { signature?: string }) | null;
    q?: string;
    status?: IssueStatusFilter;
    severity?: string;
    targetType?: string;
    targetId?: string;
    namespace?: string;
    signature?: string;
  }
): Promise<PagedResult<TargetIssue>> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const params: Array<string | number> = [workspaceId];
  const clauses = ['i.workspace_id = $1'];
  appendIssueFilters(clauses, params, options);
  return listIssuesFromSql(clauses.join(' AND '), params, limit, options.signature || '');
}

export async function listTargetIssues(
  workspaceId: string,
  targetId: string,
  options: {
    limit: number;
    cursor?: (IssuePageCursor & { signature?: string }) | null;
    q?: string;
    status?: IssueStatusFilter;
    severity?: string;
    namespace?: string;
    signature?: string;
  }
): Promise<PagedResult<TargetIssue>> {
  return listWorkspaceIssues(workspaceId, {
    ...options,
    targetId
  });
}

export async function getTargetIssue(workspaceId: string, issueId: string): Promise<TargetIssue | null> {
  const result = await db.query<TargetIssueDbRow>(
    `SELECT i.*, t.name AS target_name
     FROM target_issues i
     JOIN targets t ON t.id = i.target_id
     WHERE i.workspace_id = $1 AND i.id = $2`,
    [workspaceId, issueId]
  );
  return result.rowCount ? mapIssueRow(result.rows[0]) : null;
}

export async function listTargetIssueObservations(
  workspaceId: string,
  issueId: string,
  options: {
    limit: number;
    cursor?: (ObservationPageCursor & { signature?: string }) | null;
    signature?: string;
  }
): Promise<PagedResult<TargetIssueObservation>> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const params: Array<string | number> = [workspaceId, issueId];
  const clauses = ['o.workspace_id = $1', 'o.issue_id = $2'];
  if (options.cursor) {
    params.push(options.cursor.snapshotTs, options.cursor.observationId);
    clauses.push(
      `(o.snapshot_ts < $${params.length - 1}::timestamptz
        OR (o.snapshot_ts = $${params.length - 1}::timestamptz AND o.id > $${params.length}))`
    );
  }
  params.push(limit + 1);
  const result = await db.query<TargetIssueObservationDbRow>(
    `SELECT *
     FROM target_issue_observations o
     WHERE ${clauses.join(' AND ')}
     ORDER BY o.snapshot_ts DESC, o.id ASC
     LIMIT $${params.length}`,
    params
  );
  const page = pageWithCursor(result.rows, limit, (row) =>
    encodeCursor({
      signature: options.signature || '',
      snapshotTs: toIso(row.snapshot_ts),
      observationId: row.id
    })
  );
  return {
    items: page.items.map(mapObservationRow),
    nextCursor: page.nextCursor
  };
}

export function filterIssuesInMemory(items: TargetIssue[], filters: { q?: string; status?: IssueStatusFilter; severity?: string }): TargetIssue[] {
  return items.filter((item) => {
    if (filters.status && filters.status !== 'all' && item.status !== filters.status) return false;
    if (!filters.status && item.status === 'resolved') return false;
    if (filters.severity && item.severity !== filters.severity) return false;
    return containsSearchText([item.title, item.summary, item.reason, item.targetName, item.scopeName, item.objectKind, item.objectName], filters.q || '');
  });
}
