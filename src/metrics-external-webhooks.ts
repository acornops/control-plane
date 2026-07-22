import { increment, metricLine } from './metrics-helpers.js';

const routeRequests = new Map<string, number>();
const secretRotations = new Map<string, number>();

export function incrementExternalWebhookRouteRequest(operation: 'connect' | 'status', status: string, count = 1): void {
  increment(routeRequests, `${operation}:${status}`, count);
}

export function incrementExternalWebhookRouteSecretRotations(integrationClientId: string, count = 1): void {
  increment(secretRotations, integrationClientId, count);
}

export function renderExternalWebhookRouteMetrics(serviceLabels: Record<string, string>): string[] {
  return [
    '# HELP control_plane_external_webhook_route_requests_total External webhook route connect/status requests by operation and status.',
    '# TYPE control_plane_external_webhook_route_requests_total counter',
    ...Array.from(routeRequests.entries()).map(([key, value]) => {
      const [operation, status] = key.split(':');
      return metricLine('control_plane_external_webhook_route_requests_total', { ...serviceLabels, operation, status }, value);
    }),
    '# HELP control_plane_external_webhook_route_secret_rotations_total Webhook signing secrets rotated by external route connect.',
    '# TYPE control_plane_external_webhook_route_secret_rotations_total counter',
    ...Array.from(secretRotations.entries()).map(([integrationClientId, value]) =>
      metricLine('control_plane_external_webhook_route_secret_rotations_total', { ...serviceLabels, integration_client_id: integrationClientId }, value)
    )
  ];
}
