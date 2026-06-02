import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { VirtualMachineSnapshot, VirtualMachineTarget, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { TargetFindingInput, TargetInventoryItemInput } from './repository-target-inventory.js';
import { replaceTargetInventorySnapshot } from './repository-target-inventory.js';
import { TargetRow, toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { assertWorkspaceTargetQuota } from './repository-quotas.js';

interface VmRow extends TargetRow {
  metadata: Record<string, unknown>;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : fallback;
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
       VALUES ($1, $2, 'virtual_machine', $3, 'offline', $4::jsonb, $5, $6)`,
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
    clauses.push(`status = $${params.length}`);
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

function buildSearchText(fields: unknown[]): string {
  return fields.map((field) => String(field || '').toLowerCase()).join(' ');
}

function deriveVmInventory(vm: VirtualMachineTarget, snapshot: VirtualMachineSnapshot): {
  resources: TargetInventoryItemInput[];
  findings: TargetFindingInput[];
  summary: { inventoryCount: number; findingCount: number; criticalFindingCount: number; summary: Record<string, unknown> };
} {
  const data = snapshot.data || {};
  const host = data.host && typeof data.host === 'object' ? data.host as Record<string, unknown> : {};
  const metrics = data.metrics && typeof data.metrics === 'object' ? data.metrics as Record<string, unknown> : {};
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
  push('host', 'host', text(host.hostname, vm.hostname || vm.name), text(host.distro, 'Linux'), host);
  for (const disk of array(metrics.disks)) push('storage', 'filesystem', text(disk.mount, 'unknown'), null, disk, text(disk.filesystem) || null);
  for (const service of array(data.services)) push('services', 'systemd_service', text(service.name, 'unknown'), text(service.activeState, 'unknown'), service);
  for (const process of array(data.processes).slice(0, 100)) push('processes', 'process', text(process.name, String(process.pid || 'unknown')), null, process, text(process.user) || null);
  for (const listener of array(data.listeners)) push('network', 'listener', `${text(listener.protocol, 'tcp')}:${String(listener.port || '0')}`, null, listener, text(listener.localAddress) || null);
  for (const log of array(data.logs).slice(-100)) push('logs', 'log_entry', `${text(log.source, 'log')}:${text(log.timestamp, snapshot.timestamp)}`, null, log, text(log.unit) || null);

  const findings = array(data.findings).map((finding): TargetFindingInput => {
    const severity = text(finding.severity, 'info');
    const id = text(finding.id) || `${text(finding.objectKind, 'host')}:${text(finding.objectName, vm.name)}:${text(finding.reason, 'finding')}`;
    return {
      targetId: vm.id,
      workspaceId: vm.workspaceId,
      snapshotTs: snapshot.timestamp,
      findingId: id,
      severity,
      severityRank: findingRank(severity),
      scopeKind: null,
      scopeName: null,
      objectKind: text(finding.objectKind) || null,
      objectName: text(finding.objectName) || null,
      title: text(finding.title, 'VM finding'),
      message: text(finding.message, 'VM diagnostic finding'),
      reason: text(finding.reason) || null,
      findingTs: text(finding.timestamp, snapshot.timestamp),
      searchText: buildSearchText([finding.title, finding.message, finding.reason, finding.objectKind, finding.objectName])
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
        serviceCount: array(data.services).length,
        processCount: array(data.processes).length,
        listenerCount: array(data.listeners).length,
        logCount: array(data.logs).length
      }
    }
  };
}

export async function upsertVirtualMachineSnapshot(snapshot: VirtualMachineSnapshot): Promise<void> {
  await withTransaction(async (client) => {
    const vm = await getVirtualMachine(snapshot.targetId);
    if (!vm) throw new Error(`Cannot upsert snapshot for missing VM ${snapshot.targetId}`);
    const canonicalSnapshot = { ...snapshot, workspaceId: vm.workspaceId };
    const derived = deriveVmInventory(vm, canonicalSnapshot);
    await client.query(
      `INSERT INTO target_snapshots (target_id, workspace_id, snapshot_ts, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (target_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id, snapshot_ts = EXCLUDED.snapshot_ts, data = EXCLUDED.data`,
      [vm.id, vm.workspaceId, canonicalSnapshot.timestamp, JSON.stringify(canonicalSnapshot.data)]
    );
    await client.query(
      `INSERT INTO target_snapshot_history (id, target_id, workspace_id, snapshot_ts, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), vm.id, vm.workspaceId, canonicalSnapshot.timestamp, JSON.stringify(canonicalSnapshot.data)]
    );
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
  });
}

export async function getVirtualMachineSnapshot(vmId: string): Promise<VirtualMachineSnapshot | null> {
  const result = await db.query('SELECT * FROM target_snapshots WHERE target_id = $1', [vmId]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { targetId: row.target_id, workspaceId: row.workspace_id, timestamp: toIso(row.snapshot_ts)!, data: row.data || {} };
}

export async function listVirtualMachineSnapshotHistory(vmId: string, options: { since?: string; limit?: number } = {}): Promise<VirtualMachineSnapshot[]> {
  const params: Array<string | number> = [vmId];
  let where = 'target_id = $1';
  if (options.since) {
    params.push(options.since);
    where += ` AND snapshot_ts >= $${params.length}`;
  }
  params.push(options.limit ?? 100);
  const result = await db.query(
    `SELECT target_id, workspace_id, snapshot_ts, data
     FROM target_snapshot_history
     WHERE ${where}
     ORDER BY snapshot_ts DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.reverse().map((row) => ({
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    timestamp: toIso(row.snapshot_ts)!,
    data: row.data || {}
  }));
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

export async function listVirtualMachineFindings(vmId: string): Promise<TargetFindingInput[]> {
  const result = await db.query(
    `SELECT target_id, workspace_id, snapshot_ts, finding_id, severity, severity_rank, scope_kind,
       scope_name, object_kind, object_name, title, message, reason, finding_ts, search_text
     FROM target_findings
     WHERE target_id = $1
     ORDER BY severity_rank ASC, finding_ts DESC, finding_id ASC`,
    [vmId]
  );
  return result.rows.map((row) => ({
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    snapshotTs: toIso(row.snapshot_ts)!,
    findingId: row.finding_id,
    severity: row.severity,
    severityRank: row.severity_rank,
    scopeKind: row.scope_kind,
    scopeName: row.scope_name,
    objectKind: row.object_kind,
    objectName: row.object_name,
    title: row.title,
    message: row.message,
    reason: row.reason,
    findingTs: toIso(row.finding_ts)!,
    searchText: row.search_text
  }));
}
