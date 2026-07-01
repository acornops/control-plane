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
const runEventIngestCounts = new Map<string, number>();
const workflowSchedulerCounts = new Map<string, number>();
const approvalInboxQueries = new Map<string, number>();
const targetInsightsRetrievals = new Map<string, number>();
const targetInsightsCheckpointOutcomes = new Map<string, number>();
const targetInsightsCheckpointDurations = new Map<string, number>();
const targetInsightsCheckpointPatchCounts = new Map<string, number>();
let adminMutations = 0;
let adminAuditWriteFailures = 0;

function increment(map: Map<string, number>, key: string, count = 1): void {
  map.set(key, (map.get(key) || 0) + count);
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

export function incrementRunEventsIngested(eventType: string, count = 1): void {
  runEventIngestCounts.set(eventType, (runEventIngestCounts.get(eventType) || 0) + count);
}

export function incrementWorkflowSchedulerEvent(event: string, count = 1): void {
  workflowSchedulerCounts.set(event, (workflowSchedulerCounts.get(event) || 0) + count);
}

export function incrementApprovalInboxQuery(status: string): void {
  increment(approvalInboxQueries, status);
}

export function incrementTargetInsightsRetrieval(outcome: 'hit' | 'miss' | 'skipped' | 'error', count = 1): void {
  increment(targetInsightsRetrievals, outcome, count);
}

export function incrementTargetInsightsCheckpointOutcome(status: string, reason = 'none', count = 1): void {
  increment(targetInsightsCheckpointOutcomes, `${status}:${reason}`, count);
}

export function observeTargetInsightsCheckpointDurationMs(status: string, durationMs: number): void {
  const buckets = [1000, 5000, 15000, 30000, 60000, Number.POSITIVE_INFINITY];
  for (const bucket of buckets) {
    if (durationMs <= bucket) {
      increment(targetInsightsCheckpointDurations, `${status}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
    }
  }
}

export function recordTargetInsightsCheckpointPatchCount(status: string, patchCount: number): void {
  increment(targetInsightsCheckpointPatchCounts, status, patchCount);
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
    metricLine('control_plane_admin_audit_write_failures_total', serviceLabels, adminAuditWriteFailures),
    '# HELP control_plane_run_events_ingested_total Run events accepted from execution-engine by event type.',
    '# TYPE control_plane_run_events_ingested_total counter',
    ...Array.from(runEventIngestCounts.entries()).map(([eventType, value]) =>
      metricLine('control_plane_run_events_ingested_total', { ...serviceLabels, event_type: eventType }, value)
    ),
    '# HELP control_plane_workflow_scheduler_events_total Workflow scheduler outcomes by event.',
    '# TYPE control_plane_workflow_scheduler_events_total counter',
    ...Array.from(workflowSchedulerCounts.entries()).map(([event, value]) =>
      metricLine('control_plane_workflow_scheduler_events_total', { ...serviceLabels, event }, value)
    ),
    '# HELP control_plane_approval_inbox_queries_total Workspace approval inbox queries by status filter.',
    '# TYPE control_plane_approval_inbox_queries_total counter',
    ...Array.from(approvalInboxQueries.entries()).map(([status, value]) =>
      metricLine('control_plane_approval_inbox_queries_total', { ...serviceLabels, status }, value)
    ),
    '# HELP control_plane_target_insights_retrievals_total Target Insights retrieval outcomes for run context assembly.',
    '# TYPE control_plane_target_insights_retrievals_total counter',
    ...Array.from(targetInsightsRetrievals.entries()).map(([outcome, value]) =>
      metricLine('control_plane_target_insights_retrievals_total', { ...serviceLabels, outcome }, value)
    ),
    '# HELP control_plane_target_insights_checkpoint_outcomes_total Target Insights checkpoint outcomes by status and safe reason.',
    '# TYPE control_plane_target_insights_checkpoint_outcomes_total counter',
    ...Array.from(targetInsightsCheckpointOutcomes.entries()).map(([key, value]) => {
      const [status, reason] = key.split(':');
      return metricLine('control_plane_target_insights_checkpoint_outcomes_total', { ...serviceLabels, status, reason }, value);
    }),
    '# HELP control_plane_target_insights_checkpoint_duration_ms_bucket Target Insights checkpoint duration bucket counts by status.',
    '# TYPE control_plane_target_insights_checkpoint_duration_ms_bucket counter',
    ...Array.from(targetInsightsCheckpointDurations.entries()).map(([key, value]) => {
      const [status, le] = key.split(':');
      return metricLine('control_plane_target_insights_checkpoint_duration_ms_bucket', { ...serviceLabels, status, le }, value);
    }),
    '# HELP control_plane_target_insights_checkpoint_patches_total Target Insights patches applied by checkpoint status.',
    '# TYPE control_plane_target_insights_checkpoint_patches_total counter',
    ...Array.from(targetInsightsCheckpointPatchCounts.entries()).map(([status, value]) =>
      metricLine('control_plane_target_insights_checkpoint_patches_total', { ...serviceLabels, status }, value)
    )
  ];
  return `${lines.join('\n')}\n`;
}
