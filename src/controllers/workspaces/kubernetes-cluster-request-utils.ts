import { config } from '../../config.js';
import { KubernetesCluster, ClusterSnapshot } from '../../types/domain.js';

interface AgentInstallInstructions {
  command: string;
  releaseName: string;
  chartRef: string;
  namespace: string;
  controlPlaneUrl: string;
  namespaceInclude: string[];
  namespaceExclude: string[];
  warnings: string[];
}

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

export function parseMetricWindowMs(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : '1h';
  const match = text.match(/^(\d+)(m|h|d)$/);
  if (!match) return 60 * 60 * 1000;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 60 * 60 * 1000;

  const unit = match[2];
  const multiplier = unit === 'm' ? 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return Math.min(amount * multiplier, 30 * 24 * 60 * 60 * 1000);
}

export function parseMetricLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 48;
  return Math.max(1, Math.min(288, Math.floor(parsed)));
}

export function parseBoundedIntQuery(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function parseOptionalPositiveIntQuery(value: unknown, max: number): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export function parseBooleanQuery(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

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

export function summarizeSnapshotMetrics(snapshot: ClusterSnapshot): {
  timestamp: string;
  cpuCores: number | null;
  memoryBytes: number | null;
} | null {
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
    timestamp: snapshot.timestamp,
    cpuCores: hasCpu ? cpuCores : null,
    memoryBytes: hasMemory ? memoryBytes : null
  };
}

export function normalizeNamespaceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const namespaces: string[] = [];
  for (const item of value) {
    const namespace = String(item || '').trim();
    if (!namespace || seen.has(namespace)) continue;
    seen.add(namespace);
    namespaces.push(namespace);
  }
  return namespaces;
}

export function clusterAllowsNamespace(cluster: KubernetesCluster, namespace: string): boolean {
  const include = cluster.namespaceInclude || [];
  const exclude = cluster.namespaceExclude || [];
  if (exclude.includes(namespace)) return false;
  return include.length === 0 || include.includes(namespace);
}

function toShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function helmSetString(path: string, value: string): string {
  return `  --set-string ${path}=${toShellSingleQuoted(value)}`;
}

function helmSetJson(path: string, value: unknown): string {
  return `  --set-json ${path}=${toShellSingleQuoted(JSON.stringify(value))}`;
}

export function buildAgentInstallInstructions(cluster: KubernetesCluster, agentKey: string): AgentInstallInstructions {
  const include = cluster.namespaceInclude || [];
  const exclude = cluster.namespaceExclude || [];
  const excluded = new Set(exclude);
  const watchNamespaces = include.filter((namespace) => !excluded.has(namespace));
  const warnings: string[] = [];

  if (include.length > 0 && watchNamespaces.length === 0) {
    warnings.push('Namespace filters exclude every included namespace; the agent may observe no namespaced resources.');
  }

  const lines = [
    `helm upgrade --install ${toShellSingleQuoted(config.AGENT_HELM_RELEASE_NAME)} ${toShellSingleQuoted(config.AGENT_HELM_CHART_REF)}`,
    `  --namespace ${toShellSingleQuoted(config.AGENT_HELM_NAMESPACE)}`,
    '  --create-namespace',
    helmSetString('clusterName', cluster.name),
    helmSetString('config.platformUrl', config.CONTROL_PLANE_BASE_URL),
    helmSetString('config.clusterId', cluster.id),
    helmSetString('config.agentKey', agentKey),
    helmSetJson('namespaceScope.include', include),
    helmSetJson('namespaceScope.exclude', exclude)
  ];
  if (watchNamespaces.length > 0) {
    lines.push(helmSetString('config.watchNamespaces', watchNamespaces.join(',')));
  }

  return {
    command: lines.join(' \\\n'),
    releaseName: config.AGENT_HELM_RELEASE_NAME,
    chartRef: config.AGENT_HELM_CHART_REF,
    namespace: config.AGENT_HELM_NAMESPACE,
    controlPlaneUrl: config.CONTROL_PLANE_BASE_URL,
    namespaceInclude: include,
    namespaceExclude: exclude,
    warnings
  };
}
