import { config } from '../../config.js';
import { KubernetesCluster } from '../../types/domain.js';

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

export type AgentAccessMode = 'read_only' | 'read_write';

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

function helmSetBool(path: string, value: boolean): string {
  return `  --set ${path}=${value ? 'true' : 'false'}`;
}

export function parseAgentAccessMode(value: unknown): AgentAccessMode {
  return value === 'read_write' ? 'read_write' : 'read_only';
}

export function buildAgentInstallInstructions(
  cluster: KubernetesCluster,
  agentKey: string,
  agentAccessMode: AgentAccessMode = 'read_only'
): AgentInstallInstructions {
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
  if (agentAccessMode === 'read_write') {
    lines.push(helmSetBool('rbac.write.enabled', true));
  }
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
