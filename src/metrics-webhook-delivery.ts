import { increment, metricLine } from './metrics-helpers.js';

const eventsEnqueued = new Map<string, number>();
const deliveryAttempts = new Map<string, number>();
const deliveryDurations = new Map<string, number>();
const deliveryDurationCounts = new Map<string, number>();
const deliveryDurationSums = new Map<string, number>();
const deliveryTerminals = new Map<string, number>();
const queueDepth = new Map<string, number>();
let oversizeRejections = 0;
let leaseRecoveries = 0;
let oldestJobAgeSeconds = 0;

export function incrementWebhookEventEnqueued(eventType: string): void {
  increment(eventsEnqueued, eventType);
}

export function incrementWebhookOversizeRejection(): void {
  oversizeRejections += 1;
}

export function recordWebhookDeliveryAttempt(
  outcome: 'succeeded' | 'retrying' | 'failed',
  durationMs: number
): void {
  increment(deliveryAttempts, outcome);
  increment(deliveryDurationCounts, outcome);
  increment(deliveryDurationSums, outcome, durationMs);
  for (const bucket of [100, 500, 1000, 5000, 10000, Number.POSITIVE_INFINITY]) {
    if (durationMs <= bucket) {
      const upperBound = bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket;
      increment(deliveryDurations, `${outcome}:${upperBound}`);
    }
  }
}

export function incrementWebhookDeliveryTerminal(
  status: 'succeeded' | 'failed' | 'superseded' | 'cancelled'
): void {
  increment(deliveryTerminals, status);
}

export function incrementWebhookLeaseRecovery(): void {
  leaseRecoveries += 1;
}

export function setWebhookQueueMetrics(input: {
  pending: number;
  retrying: number;
  paused: number;
  oldestAgeSeconds: number;
}): void {
  queueDepth.set('pending', input.pending);
  queueDepth.set('retrying', input.retrying);
  queueDepth.set('paused', input.paused);
  oldestJobAgeSeconds = input.oldestAgeSeconds;
}

export function renderWebhookDeliveryMetrics(serviceLabels: Record<string, string>): string[] {
  return [
    '# HELP control_plane_webhook_events_enqueued_total Durable webhook events enqueued by event type.',
    '# TYPE control_plane_webhook_events_enqueued_total counter',
    ...Array.from(eventsEnqueued.entries()).map(([eventType, value]) =>
      metricLine('control_plane_webhook_events_enqueued_total', { ...serviceLabels, event_type: eventType }, value)
    ),
    '# HELP control_plane_webhook_delivery_attempts_total Webhook delivery attempts by outcome.',
    '# TYPE control_plane_webhook_delivery_attempts_total counter',
    ...Array.from(deliveryAttempts.entries()).map(([outcome, value]) =>
      metricLine('control_plane_webhook_delivery_attempts_total', { ...serviceLabels, outcome }, value)
    ),
    '# HELP control_plane_webhook_delivery_duration_ms Webhook delivery duration by outcome.',
    '# TYPE control_plane_webhook_delivery_duration_ms histogram',
    ...Array.from(deliveryDurations.entries()).map(([key, value]) => {
      const [outcome, le] = key.split(':');
      return metricLine(
        'control_plane_webhook_delivery_duration_ms_bucket',
        { ...serviceLabels, outcome, le },
        value
      );
    }),
    ...Array.from(deliveryDurationSums.entries()).map(([outcome, value]) =>
      metricLine('control_plane_webhook_delivery_duration_ms_sum', { ...serviceLabels, outcome }, value)
    ),
    ...Array.from(deliveryDurationCounts.entries()).map(([outcome, value]) =>
      metricLine('control_plane_webhook_delivery_duration_ms_count', { ...serviceLabels, outcome }, value)
    ),
    '# HELP control_plane_webhook_delivery_terminal_total Webhook jobs by terminal outcome.',
    '# TYPE control_plane_webhook_delivery_terminal_total counter',
    ...Array.from(deliveryTerminals.entries()).map(([status, value]) =>
      metricLine('control_plane_webhook_delivery_terminal_total', { ...serviceLabels, status }, value)
    ),
    '# HELP control_plane_webhook_oversize_rejections_total Oversize webhook envelopes rejected.',
    '# TYPE control_plane_webhook_oversize_rejections_total counter',
    metricLine('control_plane_webhook_oversize_rejections_total', serviceLabels, oversizeRejections),
    '# HELP control_plane_webhook_jobs Webhook jobs by nonterminal queue state.',
    '# TYPE control_plane_webhook_jobs gauge',
    ...Array.from(queueDepth.entries()).map(([status, value]) =>
      metricLine('control_plane_webhook_jobs', { ...serviceLabels, status }, value)
    ),
    '# HELP control_plane_webhook_oldest_job_age_seconds Age of the oldest nonterminal webhook job.',
    '# TYPE control_plane_webhook_oldest_job_age_seconds gauge',
    metricLine('control_plane_webhook_oldest_job_age_seconds', serviceLabels, oldestJobAgeSeconds),
    '# HELP control_plane_webhook_lease_recoveries_total Expired processing leases reclaimed.',
    '# TYPE control_plane_webhook_lease_recoveries_total counter',
    metricLine('control_plane_webhook_lease_recoveries_total', serviceLabels, leaseRecoveries)
  ];
}
