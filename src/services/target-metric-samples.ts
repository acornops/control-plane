import type { ClusterSnapshot, VirtualMachineSnapshot } from '../types/domain.js';

const MEMORY_BINARY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6
};

const MEMORY_DECIMAL_UNITS: Record<string, number> = {
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6
};

function parseCpuToCores(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  if (match[2] === 'n') return amount / 1_000_000_000;
  if (match[2] === 'u') return amount / 1_000_000;
  if (match[2] === 'm') return amount / 1000;
  return amount;
}

function parseMemoryToBytes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]+)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2] || '';
  if (!Number.isFinite(amount)) return null;

  if (!unit) return amount;
  if (MEMORY_BINARY_UNITS[unit]) return amount * MEMORY_BINARY_UNITS[unit];
  if (MEMORY_DECIMAL_UNITS[unit]) return amount * MEMORY_DECIMAL_UNITS[unit];
  return null;
}

function metricNodesFromSnapshot(snapshot: ClusterSnapshot): Array<{ usage?: { cpu?: unknown; memory?: unknown } }> {
  const metrics = snapshot.data.metrics;
  if (!metrics || typeof metrics !== 'object') return [];
  const nodes = (metrics as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes as Array<{ usage?: { cpu?: unknown; memory?: unknown } }> : [];
}

export function summarizeKubernetesSnapshotMetrics(snapshot: ClusterSnapshot): Record<string, unknown> | null {
  let cpuCores = 0;
  let memoryBytes = 0;
  let hasCpu = false;
  let hasMemory = false;

  for (const node of metricNodesFromSnapshot(snapshot)) {
    const cpu = parseCpuToCores(node.usage?.cpu);
    const memory = parseMemoryToBytes(node.usage?.memory);
    if (cpu !== null) {
      cpuCores += cpu;
      hasCpu = true;
    }
    if (memory !== null) {
      memoryBytes += memory;
      hasMemory = true;
    }
  }

  if (!hasCpu && !hasMemory) return null;
  return {
    cpuCores: hasCpu ? cpuCores : null,
    memoryBytes: hasMemory ? memoryBytes : null
  };
}

export function summarizeVirtualMachineSnapshotMetrics(snapshot: VirtualMachineSnapshot): Record<string, unknown> | null {
  const summary = snapshot.data.host_summary;
  if (!summary || typeof summary !== 'object') return null;
  const value = summary as Record<string, unknown>;
  const cpu = value.cpu && typeof value.cpu === 'object' ? value.cpu as Record<string, unknown> : {};
  const load = value.load && typeof value.load === 'object' ? value.load as Record<string, unknown> : {};
  const cpuUsagePercent = typeof cpu.usage_percent === 'number' && Number.isFinite(cpu.usage_percent) && cpu.usage_percent >= 0 && cpu.usage_percent <= 100
    ? cpu.usage_percent
    : null;
  return {
    loadAverage: [load.one, load.five, load.fifteen].filter((item) => typeof item === 'number'),
    cpuUsagePercent,
    memory: value.memory && typeof value.memory === 'object' && !Array.isArray(value.memory) ? value.memory : null,
    swap: value.swap && typeof value.swap === 'object' && !Array.isArray(value.swap) ? value.swap : null,
    disks: Array.isArray(snapshot.data.filesystems) ? snapshot.data.filesystems : []
  };
}
