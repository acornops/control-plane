import { z } from 'zod';
import type { VirtualMachineSnapshot, VirtualMachineTarget } from '../types/domain.js';

// Mirror AgentV's independent Windows types. Linux snapshots remain unversioned here.
const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const text = z.string().max(4096);
const health = z.object({
  collector: z.string(), status: z.enum(['ok', 'partial', 'unavailable', 'permission_denied', 'timed_out', 'unsupported']),
  duration_ms: count, message: z.string().optional()
}).strict();
const service = z.object({
  name: text, display_name: text, state: text.nullable(), start_mode: text.nullable(),
  process_id: count.nullable(), exit_code: count.nullable(), service_specific_exit_code: count.nullable()
}).strict();
const volume = z.object({
  volume: text, filesystem: text.nullable(), total_bytes: amount.nullable(), free_bytes: amount.nullable(),
  used_bytes: amount.nullable(), used_percent: amount.nullable()
}).strict();
const host = z.object({
  os_family: z.literal('windows'), hostname: text, version: text, build: text,
  product_type: z.number().int().min(2).max(3), architecture: text, system_volume: text, uptime_seconds: amount,
  cpu: z.object({ usage_percent: amount.max(100).nullable(), sampled_ms: count }).strict(),
  memory: z.object({ total_bytes: amount, available_bytes: amount, used_bytes: amount, used_percent: amount.max(100) }).strict(),
  collector_health: z.array(health)
}).strict();
const process = z.object({
  pid: count, ppid: count.nullable(), name: text, cpu_percent: amount.nullable(),
  memory_bytes: amount.nullable(), start_time: text.nullable()
}).strict();
const listener = z.object({
  protocol: z.enum(['tcp', 'udp']), address: text, port: count.max(65535), pid: count.nullable(),
  ownership_status: z.enum(['available', 'unavailable', 'permission_denied'])
}).strict();
const finding = z.discriminatedUnion('code', [
  z.object({ severity: z.literal('critical'), code: z.literal('SERVICE_FAILED'), name: text, summary: z.string() }).strict(),
  z.object({ severity: z.literal('critical'), code: z.literal('FILESYSTEM_PRESSURE'), volume: text, summary: z.string() }).strict(),
  z.object({ severity: z.literal('critical'), code: z.literal('MEMORY_PRESSURE'), summary: z.string() }).strict()
]);
export const windowsSnapshotSchema = z.object({
  schema_version: z.literal('acornops.agentv-windows-snapshot.v1'), host_summary: host.nullable(),
  filesystems: z.array(volume).max(50), degraded_services: z.array(service).max(50),
  top_processes: z.array(process).max(20), listeners: z.array(listener).max(50), findings: z.array(finding),
  collector_health: z.array(health),
  finding_coverage: z.object({ filesystems: z.enum(['complete', 'incomplete']), services: z.enum(['complete', 'incomplete']) }).strict(),
  truncation: z.object({ filesystems: count, services: count, processes: count, listeners: count }).strict()
}).strict();

export function isWindowsSnapshot(snapshot: VirtualMachineSnapshot): boolean {
  return snapshot.data.schema_version === 'acornops.agentv-windows-snapshot.v1';
}

/** Authenticate identity from persistence, never from a submitted discriminator. */
export function validateVirtualMachineSnapshot(vm: VirtualMachineTarget, snapshot: VirtualMachineSnapshot): void {
  if (vm.osFamily === 'windows') {
    if (!windowsSnapshotSchema.safeParse(snapshot.data).success) throw new Error('Invalid Windows snapshot');
    return;
  }
  const host = snapshot.data.host_summary as Record<string, unknown> | null | undefined;
  if (String(snapshot.data.schema_version || '').startsWith('acornops.agentv-windows-snapshot.') || host?.os_family === 'windows') {
    throw new Error('Windows snapshot does not match stored VM platform');
  }
}

export function isFailedWindowsService(service: Record<string, unknown>): boolean {
  return service.state === 'Stopped' && ['Auto', 'Automatic', 'Manual'].includes(String(service.start_mode))
    && typeof service.exit_code === 'number' && Number.isFinite(service.exit_code)
    && service.exit_code !== 0 && service.exit_code !== 1077;
}

/** Fixed display projection; runtime collector names/messages never cross this boundary. */
export function projectWindowsCollectionStatus(snapshot: VirtualMachineSnapshot) {
  const parsed = windowsSnapshotSchema.safeParse(snapshot.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const status = (collector: string) => {
    const entries = data.collector_health.filter((entry) => entry.collector === collector);
    return entries.find((entry) => entry.status !== 'ok')?.status ?? entries[0]?.status ?? 'unknown';
  };
  const count = (value: number) => Math.min(value, Number.MAX_SAFE_INTEGER);
  return {
    targetId: snapshot.targetId, workspaceId: snapshot.workspaceId, snapshotTs: snapshot.timestamp,
    categories: {
      host: { status: status('windows_host') },
      filesystems: { status: status('windows_volumes'), omittedCount: count(data.truncation.filesystems), findingCoverage: data.finding_coverage.filesystems },
      services: { status: status('windows_services'), omittedCount: count(data.truncation.services), findingCoverage: data.finding_coverage.services },
      processes: { status: status('windows_processes'), omittedCount: count(data.truncation.processes) },
      network: { status: status('windows_listeners'), omittedCount: count(data.truncation.listeners) }
    }
  };
}
