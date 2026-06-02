import { config } from './config.js';

function prometheusEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const labelText = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${prometheusEscape(labelValue)}"`)
    .join(',');
  return `${name}{${labelText}} ${Number.isFinite(value) ? value : 0}`;
}

const adminAuthFailures = new Map<string, number>();
const adminRequests = new Map<string, number>();
let adminMutations = 0;
let adminAuditWriteFailures = 0;

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

export function incrementAdminAuthFailures(reason: string): void {
  increment(adminAuthFailures, reason);
}

export function incrementAdminRequests(method: string, route: string, status: number): void {
  increment(adminRequests, `${method}:${route}:${status}`);
}

export function incrementAdminMutations(): void {
  adminMutations += 1;
}

export function incrementAdminAuditWriteFailures(): void {
  adminAuditWriteFailures += 1;
}

export function renderControlPlaneMetrics(): string {
  const serviceLabels = {
    service: 'acornops-control-plane',
    node_env: config.NODE_ENV
  };
  const memory = process.memoryUsage();
  const lines = [
    '# HELP acornops_control_plane_up Whether the control plane process is running.',
    '# TYPE acornops_control_plane_up gauge',
    metricLine('acornops_control_plane_up', serviceLabels, 1),
    '# HELP acornops_control_plane_uptime_seconds Process uptime in seconds.',
    '# TYPE acornops_control_plane_uptime_seconds gauge',
    metricLine('acornops_control_plane_uptime_seconds', serviceLabels, process.uptime()),
    '# HELP acornops_control_plane_memory_bytes Node.js process memory usage by area.',
    '# TYPE acornops_control_plane_memory_bytes gauge',
    ...Object.entries(memory).map(([area, value]) =>
      metricLine('acornops_control_plane_memory_bytes', { ...serviceLabels, area }, value)
    ),
    '# HELP acornops_control_plane_distributed_routing_enabled Whether Redis-backed control-plane routing is enabled.',
    '# TYPE acornops_control_plane_distributed_routing_enabled gauge',
    metricLine(
      'acornops_control_plane_distributed_routing_enabled',
      serviceLabels,
      config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED ? 1 : 0
    ),
    '# HELP control_plane_admin_auth_failures_total Admin bearer auth failures by safe reason.',
    '# TYPE control_plane_admin_auth_failures_total counter',
    ...Array.from(adminAuthFailures.entries()).map(([reason, value]) =>
      metricLine('control_plane_admin_auth_failures_total', { ...serviceLabels, reason }, value)
    ),
    '# HELP control_plane_admin_requests_total Admin API requests by method, route, and status.',
    '# TYPE control_plane_admin_requests_total counter',
    ...Array.from(adminRequests.entries()).map(([key, value]) => {
      const [method, route, status] = key.split(':');
      return metricLine('control_plane_admin_requests_total', { ...serviceLabels, method, route, status }, value);
    }),
    '# HELP control_plane_admin_mutations_total Admin API mutation requests accepted by controllers.',
    '# TYPE control_plane_admin_mutations_total counter',
    metricLine('control_plane_admin_mutations_total', serviceLabels, adminMutations),
    '# HELP control_plane_admin_audit_write_failures_total Admin audit write failures.',
    '# TYPE control_plane_admin_audit_write_failures_total counter',
    metricLine('control_plane_admin_audit_write_failures_total', serviceLabels, adminAuditWriteFailures)
  ];
  return `${lines.join('\n')}\n`;
}
