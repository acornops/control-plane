import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { deriveVirtualMachineIssueObservations } from '../services/target-issue-derivation.js';
import { summarizeVirtualMachineSnapshotMetrics } from '../services/target-metric-samples.js';
import { VirtualMachineSnapshot, VirtualMachineTarget, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { TargetFindingInput, TargetInventoryItemInput } from './repository-target-inventory.js';
import { replaceTargetInventorySnapshot } from './repository-target-inventory.js';
import { TargetRow, toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { enqueueTargetAutomationEvent } from './repository-automation-events.js';
import { reconcileTargetIssues } from './repository-target-issues.js';
import { assertWorkspaceTargetQuota } from './repository-quotas.js';
import { upsertTargetMetricSample } from './repository-target-metrics.js';

interface VmRow extends TargetRow {
  metadata: Record<string, unknown>;
}

interface PreviousSnapshotRow {
  snapshot_ts: Date | string;
}

function isNewerSnapshot(currentTimestamp: string, previousTimestamp: string): boolean {
  const currentTime = Date.parse(currentTimestamp);
  const previousTime = Date.parse(previousTimestamp);
  return Number.isFinite(currentTime) && Number.isFinite(previousTime)
    ? currentTime > previousTime
    : currentTimestamp > previousTimestamp;
}

interface SnapshotSummaryDbRow {
  target_id: string;
  workspace_id: string;
  snapshot_ts: Date | string;
  inventory_count: number | string;
  finding_count: number | string;
  critical_finding_count: number | string;
  summary: Record<string, unknown> | null;
}

export interface VirtualMachineSnapshotSummary {
  inventoryCount: number;
  findingCount: number;
  criticalFindingCount: number;
  serviceCount: number;
  processCount: number;
  listenerCount: number;
  logCount: number;
}

export interface VirtualMachineSnapshotSummaryRecord {
  latestSnapshot: {
    targetId: string;
    workspaceId: string;
    timestamp: string;
  };
  summary: VirtualMachineSnapshotSummary;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : fallback;
}

function numberFromSummary(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === 'number' ? value : 0;
}

function mapVirtualMachineSnapshotSummaryRecord(row: SnapshotSummaryDbRow): VirtualMachineSnapshotSummaryRecord {
  const summary = row.summary || {};
  return {
    latestSnapshot: {
      targetId: row.target_id,
      workspaceId: row.workspace_id,
      timestamp: toIso(row.snapshot_ts)!
    },
    summary: {
      inventoryCount: Number(row.inventory_count),
      findingCount: Number(row.finding_count),
      criticalFindingCount: Number(row.critical_finding_count),
      serviceCount: numberFromSummary(summary, 'serviceCount'),
      processCount: numberFromSummary(summary, 'processCount'),
      listenerCount: numberFromSummary(summary, 'listenerCount'),
      logCount: numberFromSummary(summary, 'logCount')
    }
  };
}

function mapVm(row: VmRow): VirtualMachineTarget {
  const metadata = row.metadata || {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    hostname: text(metadata.hostname) || undefined,
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: stringList(metadata.allowedLogSources, ['journald', 'syslog']),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export async function addVirtualMachine(
  workspaceId: string,
  input: { name: string; hostname?: string; allowedLogSources?: string[] }
): Promise<VirtualMachineTarget> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const metadata = {
    hostname: input.hostname || input.name,
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: input.allowedLogSources || ['journald', 'syslog']
  };
  await withTransaction(async (client) => {
    await assertWorkspaceTargetQuota(client, workspaceId, VIRTUAL_MACHINE_TARGET_TYPE);
    await client.query(
      `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
       VALUES ($1, $2, 'virtual_machine', $3, 'unknown', $4::jsonb, $5, $6)`,
      [id, workspaceId, input.name, JSON.stringify(metadata), now, now]
    );
  });
  const vm = await getVirtualMachine(id);
  if (!vm) throw new Error(`Failed to create VM target ${id}`);
  return vm;
}

export async function listVirtualMachines(
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: { createdAt: string; vmId: string } | null;
    q?: string;
    status?: VirtualMachineTarget['status'];
    signature?: string;
  } = {}
): Promise<PagedResult<VirtualMachineTarget>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [workspaceId, limit + 1];
  const clauses = ['workspace_id = $1', "target_type = 'virtual_machine'"];
  if (options.status) {
    params.push(options.status);
    clauses.push(options.status === 'offline'
      ? `(status = $${params.length} OR status = 'unknown')`
      : `status = $${params.length}`);
  }
  if (options.q) {
    params.push(`%${options.q.toLowerCase()}%`);
    clauses.push(`(LOWER(name) LIKE $${params.length} OR LOWER(metadata->>'hostname') LIKE $${params.length})`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.vmId);
    clauses.push(`(created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query<VmRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    params
  );
  return pageWithCursor(result.rows.map(mapVm), limit, (vm) =>
    encodeCursor({ signature: options.signature || '', createdAt: vm.createdAt, vmId: vm.id })
  );
}

export async function getVirtualMachine(vmId: string): Promise<VirtualMachineTarget | null> {
  const result = await db.query<VmRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE id = $1 AND target_type = 'virtual_machine'`,
    [vmId]
  );
  return result.rowCount ? mapVm(result.rows[0]) : null;
}

export async function updateVirtualMachine(
  vmId: string,
  input: Partial<Pick<VirtualMachineTarget, 'name' | 'hostname' | 'status' | 'allowedLogSources'>>
): Promise<VirtualMachineTarget | null> {
  const existing = await getVirtualMachine(vmId);
  if (!existing) return null;
  const metadata = {
    hostname: input.hostname ?? existing.hostname ?? existing.name,
    osFamily: 'linux',
    serviceManager: 'systemd',
    allowedLogSources: input.allowedLogSources ?? existing.allowedLogSources
  };
  await db.query(
    `UPDATE targets
     SET name = $2, status = $3, metadata = $4::jsonb, updated_at = $5
     WHERE id = $1 AND target_type = 'virtual_machine'`,
    [vmId, input.name ?? existing.name, input.status ?? existing.status, JSON.stringify(metadata), new Date().toISOString()]
  );
  return getVirtualMachine(vmId);
}

export async function deleteVirtualMachine(vmId: string): Promise<boolean> {
  const result = await db.query("DELETE FROM targets WHERE id = $1 AND target_type = 'virtual_machine'", [vmId]);
  return Boolean(result.rowCount);
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')) : [];
}

function findingRank(severity: string): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function normalizeFindingSeverity(value: unknown): 'critical' | 'warning' | 'info' {
  const severity = text(value, 'info').toLowerCase();
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') return 'warning';
  return 'info';
}

function buildSearchText(fields: unknown[]): string {
  return fields.map((field) => String(field || '').toLowerCase()).join(' ');
}

function deriveVmInventory(vm: VirtualMachineTarget, snapshot: VirtualMachineSnapshot): {
  resources: TargetInventoryItemInput[];
  findings: TargetFindingInput[];
  summary: { inventoryCount: number; findingCount: number; criticalFindingCount: number; summary: Record<string, unknown> };
} {
  const data = snapshot.data || {};
  const host = data.host_summary && typeof data.host_summary === 'object' ? data.host_summary as Record<string, unknown> : {};
  const resources: TargetInventoryItemInput[] = [];
  function push(category: string, kind: string, name: string, status: string | null, item: Record<string, unknown>, location: string | null = null): void {
    const itemId = `${category}:${kind}:${name}`;
    resources.push({
      targetId: vm.id,
      workspaceId: vm.workspaceId,
      snapshotTs: snapshot.timestamp,
      itemId,
      category,
      kind,
      scopeKind: null,
      scopeName: null,
      name,
      status,
      location,
      needsAttention: /failed|inactive|pressure|high/i.test(status || ''),
      sortKey: `${category}:${kind}:${name}`,
      searchText: buildSearchText([category, kind, name, status, location]),
      item
    });
  }
  const distro = host.distro && typeof host.distro === 'object' ? host.distro as Record<string, unknown> : {};
  push('host', 'host', text(host.hostname, vm.hostname || vm.name), text(distro.pretty_name, 'Linux'), host);
  for (const disk of array(data.filesystems)) push('storage', 'filesystem', text(disk.mount, 'unknown'), Number(disk.used_percent) >= 90 ? 'pressure' : null, disk, text(disk.filesystem) || null);
  for (const service of array(data.degraded_services)) push('services', 'systemd_service', text(service.unit, 'unknown'), text(service.active_state, 'unknown'), service);
  for (const process of array(data.top_processes).slice(0, 100)) push('processes', 'process', text(process.name, String(process.pid || 'unknown')), null, process, text(process.user) || null);
  for (const listener of array(data.listeners)) push('network', 'listener', `${text(listener.protocol, 'tcp')}:${String(listener.port || '0')}`, null, listener, text(listener.address) || null);

  const findings = array(data.findings).map((finding): TargetFindingInput => {
    const severity = normalizeFindingSeverity(finding.severity);
    const objectName = text(finding.unit, text(finding.mount, vm.name));
    const reason = text(finding.code, 'finding');
    const id = `${text(finding.unit ? 'systemd_service' : 'host')}:${objectName}:${reason}`;
    return {
      targetId: vm.id,
      workspaceId: vm.workspaceId,
      snapshotTs: snapshot.timestamp,
      findingId: id,
      severity,
      severityRank: findingRank(severity),
      scopeKind: null,
      scopeName: null,
      objectKind: finding.unit ? 'systemd_service' : 'host',
      objectName,
      title: text(finding.summary, 'VM finding'),
      message: text(finding.summary, 'VM diagnostic finding'),
      reason,
      findingTs: snapshot.timestamp,
      searchText: buildSearchText([finding.summary, finding.code, finding.unit, finding.mount])
    };
  });
  return {
    resources,
    findings,
    summary: {
      inventoryCount: resources.length,
      findingCount: findings.length,
      criticalFindingCount: findings.filter((finding) => finding.severity === 'critical').length,
      summary: {
        host: host.hostname || vm.hostname || vm.name,
        osFamily: 'linux',
        serviceManager: 'systemd',
        serviceCount: array(data.degraded_services).length,
        processCount: array(data.top_processes).length,
        listenerCount: array(data.listeners).length,
        logCount: 0
      }
    }
  };
}

export async function upsertVirtualMachineSnapshot(snapshot: VirtualMachineSnapshot): Promise<void> {
  await withTransaction(async (client) => {
    const vm = await getVirtualMachine(snapshot.targetId);
    if (!vm) throw new Error(`Cannot upsert snapshot for missing VM ${snapshot.targetId}`);
    const canonicalSnapshot = { ...snapshot, workspaceId: vm.workspaceId };
    const previousSnapshotResult = await client.query<PreviousSnapshotRow>(
      `SELECT snapshot_ts
       FROM target_snapshots
       WHERE target_id = $1
       FOR UPDATE`,
      [vm.id]
    );
    const previousTimestamp = previousSnapshotResult.rows.length > 0
      ? toIso(previousSnapshotResult.rows[0].snapshot_ts)
      : undefined;
    if (previousTimestamp && !isNewerSnapshot(canonicalSnapshot.timestamp, previousTimestamp)) return;
    const derived = deriveVmInventory(vm, canonicalSnapshot);
    await client.query(
      `INSERT INTO target_snapshots (target_id, workspace_id, snapshot_ts, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (target_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id, snapshot_ts = EXCLUDED.snapshot_ts, data = EXCLUDED.data`,
      [vm.id, vm.workspaceId, canonicalSnapshot.timestamp, JSON.stringify(canonicalSnapshot.data)]
    );
    await upsertTargetMetricSample(client, {
      targetId: vm.id,
      workspaceId: vm.workspaceId,
      targetType: 'virtual_machine',
      timestamp: canonicalSnapshot.timestamp,
      metrics: summarizeVirtualMachineSnapshotMetrics(canonicalSnapshot)
    });
    await replaceTargetInventorySnapshot(client, {
      targetId: vm.id,
      resources: derived.resources,
      findings: derived.findings,
      summary: {
        targetId: vm.id,
        workspaceId: vm.workspaceId,
        snapshotTs: canonicalSnapshot.timestamp,
        ...derived.summary
      }
    });
    await reconcileTargetIssues(client, {
      targetId: vm.id,
      snapshotTs: canonicalSnapshot.timestamp,
      observations: deriveVirtualMachineIssueObservations(vm, canonicalSnapshot)
    });
    await enqueueTargetAutomationEvent(client, {
      workspaceId: vm.workspaceId,
      targetId: vm.id,
      targetType: 'virtual_machine',
      eventType: 'target.snapshot.updated.v1',
      occurrenceKey: canonicalSnapshot.timestamp,
      occurredAt: canonicalSnapshot.timestamp
    });
  });
}

export async function getVirtualMachineSnapshot(vmId: string): Promise<VirtualMachineSnapshot | null> {
  const result = await db.query('SELECT * FROM target_snapshots WHERE target_id = $1', [vmId]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { targetId: row.target_id, workspaceId: row.workspace_id, timestamp: toIso(row.snapshot_ts)!, data: row.data || {} };
}

export async function getVirtualMachineSnapshotSummary(vmId: string): Promise<VirtualMachineSnapshotSummaryRecord | null> {
  const result = await db.query<SnapshotSummaryDbRow>(
    `SELECT s.target_id, s.workspace_id, s.snapshot_ts, s.inventory_count, s.finding_count,
       s.critical_finding_count, s.summary
     FROM target_snapshot_summaries s
     JOIN targets t ON t.id = s.target_id AND t.target_type = 'virtual_machine'
     WHERE s.target_id = $1`,
    [vmId]
  );
  if (!result.rowCount) return null;
  return mapVirtualMachineSnapshotSummaryRecord(result.rows[0]);
}

export async function listVirtualMachineSnapshotSummaries(vmIds: string[]): Promise<Map<string, VirtualMachineSnapshotSummaryRecord>> {
  if (vmIds.length === 0) return new Map();
  const result = await db.query<SnapshotSummaryDbRow>(
    `SELECT s.target_id, s.workspace_id, s.snapshot_ts, s.inventory_count, s.finding_count,
       s.critical_finding_count, s.summary
     FROM target_snapshot_summaries s
     JOIN targets t ON t.id = s.target_id AND t.target_type = 'virtual_machine'
     WHERE s.target_id = ANY($1::text[])`,
    [vmIds]
  );
  return new Map(result.rows.map((row) => [row.target_id, mapVirtualMachineSnapshotSummaryRecord(row)]));
}

export async function listVirtualMachineInventory(vmId: string): Promise<TargetInventoryItemInput[]> {
  const result = await db.query(
    `SELECT target_id, workspace_id, snapshot_ts, item_id, category, kind, scope_kind, scope_name,
       name, status, location, needs_attention, sort_key, search_text, item
     FROM target_inventory_items
     WHERE target_id = $1
     ORDER BY sort_key ASC`,
    [vmId]
  );
  return result.rows.map((row) => ({
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    snapshotTs: toIso(row.snapshot_ts)!,
    itemId: row.item_id,
    category: row.category,
    kind: row.kind,
    scopeKind: row.scope_kind,
    scopeName: row.scope_name,
    name: row.name,
    status: row.status,
    location: row.location,
    needsAttention: row.needs_attention,
    sortKey: row.sort_key,
    searchText: row.search_text,
    item: row.item || {}
  }));
}
