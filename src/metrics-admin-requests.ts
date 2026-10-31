import { increment, metricLine } from './metrics-helpers.js';

// Server-owned templates only. Router parity is checked in admin-request-metrics.test.ts.
export const ADMIN_REQUEST_METRIC_ROUTE_LABELS: readonly string[] = Object.freeze([
  '/admin-audit-events',
  '/admin-auth/csrf',
  '/admin-auth/logout',
  '/admin-auth/oidc/callback',
  '/admin-auth/oidc/login',
  '/audit-events',
  '/me',
  '/runs',
  '/runs/:runId',
  '/runs/:runId/cancel',
  '/runs/:runId/mark-failed',
  '/system/config',
  '/system/llm-provider-defaults',
  '/system/llm-provider-defaults/:provider',
  '/system/readiness',
  '/system/settings',
  '/system/settings/:settingKey',
  '/system/workspace-defaults',
  '/system/workspace-defaults/:id',
  '/system/workspace-defaults/resolve-skill',
  '/targets',
  '/targets/:targetId/agent',
  '/targets/:targetId/agent-key/rotate',
  '/targets/:targetId/agent/disconnect',
  '/tooling/sync',
  '/users',
  '/users/summary',
  '/users/:userId',
  '/users/:userId/sessions/revoke',
  '/workspace-plans',
  '/workspaces',
  '/workspaces/summary',
  '/workspaces/:workspaceId',
  '/workspaces/:workspaceId/members',
  '/workspaces/:workspaceId/members/:userId',
  '/workspaces/:workspaceId/members/:userId/role',
  '/workspaces/:workspaceId/plan',
  '/workspaces/:workspaceId/policy',
  '/workspaces/:workspaceId/quotas',
  '/workspaces/:workspaceId/restore',
  '/workspaces/:workspaceId/suspend',
]);
const routes = new Set(ADMIN_REQUEST_METRIC_ROUTE_LABELS);
const methods = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const requests = new Map<string, number>();

export function incrementAdminRequests(method: string, route: string, status: number): void {
  const upperMethod = method.toUpperCase();
  const labels = [
    methods.has(upperMethod) ? upperMethod : 'OTHER',
    routes.has(route) ? route : 'unmatched',
    Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'other'
  ];
  increment(requests, JSON.stringify(labels));
}

export function renderAdminRequestMetrics(serviceLabels: Record<string, string>): string[] {
  return Array.from(requests, ([key, value]) => {
    const [method, route, status] = JSON.parse(key) as [string, string, string];
    return metricLine('control_plane_admin_requests_total', { ...serviceLabels, method, route, status }, value);
  });
}
