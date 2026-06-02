import type { PoolClient } from 'pg';

type QueryClient = Pick<PoolClient, 'query'>;

export interface TargetInventoryItemInput {
  targetId: string;
  workspaceId: string;
  snapshotTs: string;
  itemId: string;
  category: string;
  kind: string;
  scopeKind: string | null;
  scopeName: string | null;
  name: string;
  status: string | null;
  location: string | null;
  needsAttention: boolean;
  sortKey: string;
  searchText: string;
  item: Record<string, unknown>;
}

export interface TargetFindingInput {
  targetId: string;
  workspaceId: string;
  snapshotTs: string;
  findingId: string;
  severity: string;
  severityRank: number;
  scopeKind: string | null;
  scopeName: string | null;
  objectKind: string | null;
  objectName: string | null;
  title: string;
  message: string;
  reason: string | null;
  findingTs: string;
  searchText: string;
}

export interface TargetSnapshotSummaryInput {
  targetId: string;
  workspaceId: string;
  snapshotTs: string;
  inventoryCount: number;
  findingCount: number;
  criticalFindingCount: number;
  summary: Record<string, unknown>;
}

async function insertTargetInventoryItems(client: QueryClient, rows: TargetInventoryItemInput[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO target_inventory_items (
       target_id, workspace_id, snapshot_ts, item_id, category, kind, scope_kind, scope_name, name, status, location,
       needs_attention, sort_key, search_text, item
     )
     SELECT row.target_id, row.workspace_id, row.snapshot_ts::timestamptz, row.item_id, row.category,
       row.kind, row.scope_kind, row.scope_name, row.name, row.status, row.location, row.needs_attention, row.sort_key,
       row.search_text, row.item
     FROM jsonb_to_recordset($1::jsonb) AS row(
       target_id text, workspace_id text, snapshot_ts text, item_id text, category text, kind text,
       scope_kind text, scope_name text, name text, status text, location text, needs_attention boolean, sort_key text,
       search_text text, item jsonb
     )`,
    [
      JSON.stringify(rows.map((row) => ({
        target_id: row.targetId,
        workspace_id: row.workspaceId,
        snapshot_ts: row.snapshotTs,
        item_id: row.itemId,
        category: row.category,
        kind: row.kind,
        scope_kind: row.scopeKind,
        scope_name: row.scopeName,
        name: row.name,
        status: row.status,
        location: row.location,
        needs_attention: row.needsAttention,
        sort_key: row.sortKey,
        search_text: row.searchText,
        item: row.item
      })))
    ]
  );
}

async function insertTargetFindings(client: QueryClient, rows: TargetFindingInput[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO target_findings (
       target_id, workspace_id, snapshot_ts, finding_id, severity, severity_rank, scope_kind, scope_name, object_kind,
       object_name, title, message, reason, finding_ts, search_text
     )
     SELECT row.target_id, row.workspace_id, row.snapshot_ts::timestamptz, row.finding_id, row.severity,
       row.severity_rank, row.scope_kind, row.scope_name, row.object_kind, row.object_name, row.title, row.message,
       row.reason, row.finding_ts::timestamptz, row.search_text
     FROM jsonb_to_recordset($1::jsonb) AS row(
       target_id text, workspace_id text, snapshot_ts text, finding_id text, severity text,
       severity_rank integer, scope_kind text, scope_name text, object_kind text, object_name text, title text,
       message text, reason text, finding_ts text, search_text text
     )`,
    [
      JSON.stringify(rows.map((row) => ({
        target_id: row.targetId,
        workspace_id: row.workspaceId,
        snapshot_ts: row.snapshotTs,
        finding_id: row.findingId,
        severity: row.severity,
        severity_rank: row.severityRank,
        scope_kind: row.scopeKind,
        scope_name: row.scopeName,
        object_kind: row.objectKind,
        object_name: row.objectName,
        title: row.title,
        message: row.message,
        reason: row.reason,
        finding_ts: row.findingTs,
        search_text: row.searchText
      })))
    ]
  );
}

async function upsertTargetSnapshotSummary(client: QueryClient, summary: TargetSnapshotSummaryInput): Promise<void> {
  await client.query(
    `INSERT INTO target_snapshot_summaries (
       target_id, workspace_id, snapshot_ts, inventory_count, finding_count, critical_finding_count,
       summary, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     ON CONFLICT (target_id) DO UPDATE
     SET workspace_id = EXCLUDED.workspace_id,
         snapshot_ts = EXCLUDED.snapshot_ts,
         inventory_count = EXCLUDED.inventory_count,
         finding_count = EXCLUDED.finding_count,
         critical_finding_count = EXCLUDED.critical_finding_count,
         summary = EXCLUDED.summary,
         updated_at = NOW()`,
    [
      summary.targetId,
      summary.workspaceId,
      summary.snapshotTs,
      summary.inventoryCount,
      summary.findingCount,
      summary.criticalFindingCount,
      JSON.stringify(summary.summary)
    ]
  );
}

export async function replaceTargetInventorySnapshot(
  client: QueryClient,
  input: {
    targetId: string;
    resources: TargetInventoryItemInput[];
    findings: TargetFindingInput[];
    summary: TargetSnapshotSummaryInput;
  }
): Promise<void> {
  await client.query('DELETE FROM target_inventory_items WHERE target_id = $1', [input.targetId]);
  await client.query('DELETE FROM target_findings WHERE target_id = $1', [input.targetId]);
  await insertTargetInventoryItems(client, input.resources);
  await insertTargetFindings(client, input.findings);
  await upsertTargetSnapshotSummary(client, input.summary);
}
