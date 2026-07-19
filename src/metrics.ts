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
const approvalInboxQueryDurations = new Map<string, number>();
const targetInsightsRetrievals = new Map<string, number>();
const targetInsightsCheckpointOutcomes = new Map<string, number>();
const targetInsightsCheckpointDurations = new Map<string, number>();
const targetInsightsCheckpointPatchCounts = new Map<string, number>();
const workflowRepositoryFailures = new Map<string, number>();
const workflowCatalogSourceAvailability = new Map<string, number>();
const workflowSchedulePreviewDurations = new Map<string, number>();
const workflowExecutionStreams = new Map<string, number>();
const automationDispatches = new Map<string, number>();
const automationDispatchDurations = new Map<string, number>();
const automationTriggers = new Map<string, number>();
const automationApprovals = new Map<string, number>();
const automationTerminalOutcomes = new Map<string, number>();
const automationPdfRenders = new Map<string, number>();
const automationPdfRenderDurations = new Map<string, number>();
const automationMcpFailures = new Map<string, number>();
let automationGauges: Record<string, number> = {};
const toolResultArtifactEvents = new Map<string, number>();
const toolResultArtifactSizes = new Map<string, number>();
const toolResultArtifactSizeCounts = new Map<string, number>();
const toolResultArtifactSizeSums = new Map<string, number>();
const externalWebhookRouteRequests = new Map<string, number>();
const webhookEventsEnqueued = new Map<string, number>();
const webhookDeliveryAttempts = new Map<string, number>();
const webhookDeliveryDurations = new Map<string, number>();
const webhookDeliveryTerminal = new Map<string, number>();
let externalWebhookRouteSecretRotations = 0;
let webhookOversizeRejections = 0;
let webhookLeaseRecoveries = 0;
let webhookOldestJobAgeSeconds = 0;
const webhookQueueDepth = new Map<string, number>();
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

export function incrementApprovalInboxQuery(status: string, outcome: 'success' | 'denied' | 'error' = 'success'): void {
  increment(approvalInboxQueries, `${status}:${outcome}`);
}

export function observeApprovalInboxQueryDurationMs(
  status: string,
  outcome: 'success' | 'denied' | 'error',
  durationMs: number
): void {
  const buckets = [10, 50, 100, 250, 500, 1000, Number.POSITIVE_INFINITY];
  for (const bucket of buckets) {
    if (durationMs <= bucket) {
      increment(approvalInboxQueryDurations, `${status}:${outcome}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
    }
  }
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

export function incrementWorkflowRepositoryFailure(repository: string, operation: string): void {
  increment(workflowRepositoryFailures, `${repository}:${operation}`);
}

export function incrementWorkflowCatalogSource(source: string, status: string): void {
  increment(workflowCatalogSourceAvailability, `${source}:${status}`);
}

export function observeWorkflowSchedulePreviewDurationMs(status: 'valid' | 'invalid' | 'error', durationMs: number): void {
  const buckets = [10, 50, 100, 250, 500, 1000, Number.POSITIVE_INFINITY];
  for (const bucket of buckets) {
    if (durationMs <= bucket) {
      increment(workflowSchedulePreviewDurations, `${status}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
    }
  }
}

export function incrementWorkflowExecutionStream(event: 'opened' | 'closed' | 'replayed' | 'error', count = 1): void {
  increment(workflowExecutionStreams, event, count);
}

export function incrementAutomationDispatch(source: string, outcome: string): void {
  increment(automationDispatches, `${source}:${outcome}`);
}

export function observeAutomationDispatchDurationMs(source: string, outcome: string, durationMs: number): void {
  for (const bucket of [100, 500, 1000, 5000, 15000, 30000, Number.POSITIVE_INFINITY]) {
    if (durationMs <= bucket) increment(automationDispatchDurations, `${source}:${outcome}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
  }
}

export function incrementAutomationTrigger(triggerType: string, outcome: string): void {
  increment(automationTriggers, `${triggerType}:${outcome}`);
}

export function incrementAutomationApproval(kind: string, outcome: string): void {
  increment(automationApprovals, `${kind}:${outcome}`);
}

export function incrementAutomationTerminalOutcome(source: string, status: string): void {
  increment(automationTerminalOutcomes, `${source}:${status}`);
}

export function incrementAutomationMcpFailure(operation: string): void {
  increment(automationMcpFailures, operation);
}

export function observeAutomationPdfRender(outcome: string, durationMs: number, outputBytes = 0): void {
  increment(automationPdfRenders, `${outcome}:renders`);
  increment(automationPdfRenders, `${outcome}:bytes`, outputBytes);
  for (const bucket of [100, 500, 1000, 5000, 15000, 30000, Number.POSITIVE_INFINITY]) {
    if (durationMs <= bucket) increment(automationPdfRenderDurations, `${outcome}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
  }
}

export function setAutomationGauges(snapshot: Record<string, number>): void {
  automationGauges = { ...snapshot };
}

export function incrementToolResultArtifactEvent(event: string, count = 1): void {
  increment(toolResultArtifactEvents, event, count);
}

export function observeToolResultArtifactBytes(view: 'compressed' | 'uncompressed', bytes: number): void {
  for (const bucket of [1024, 16_384, 65_536, 262_144, 1_048_576, 2_097_152, Number.POSITIVE_INFINITY]) {
    if (bytes <= bucket) increment(toolResultArtifactSizes, `${view}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
  }
  increment(toolResultArtifactSizeCounts, view);
  increment(toolResultArtifactSizeSums, view, bytes);
}

export function incrementExternalWebhookRouteRequest(operation: 'connect' | 'status', status: string, count = 1): void {
  increment(externalWebhookRouteRequests, `${operation}:${status}`, count);
}

export function incrementExternalWebhookRouteSecretRotations(_integrationClientId: string, count = 1): void {
  externalWebhookRouteSecretRotations += count;
}

export function incrementWebhookEventEnqueued(eventType: string): void {
  increment(webhookEventsEnqueued, eventType);
}

export function incrementWebhookOversizeRejection(): void {
  webhookOversizeRejections += 1;
}

export function recordWebhookDeliveryAttempt(outcome: string, durationMs: number): void {
  increment(webhookDeliveryAttempts, outcome);
  for (const bucket of [100, 500, 1000, 5000, 10000, Number.POSITIVE_INFINITY]) {
    if (durationMs <= bucket) {
      increment(webhookDeliveryDurations, `${outcome}:${bucket === Number.POSITIVE_INFINITY ? '+Inf' : bucket}`);
    }
  }
}

export function incrementWebhookDeliveryTerminal(status: 'retrying' | 'superseded' | 'cancelled' | 'failed'): void {
  increment(webhookDeliveryTerminal, status);
}

export function incrementWebhookLeaseRecovery(): void {
  webhookLeaseRecoveries += 1;
}

export function setWebhookQueueMetrics(input: {
  pending: number;
  retrying: number;
  paused: number;
  oldestAgeSeconds: number;
}): void {
  webhookQueueDepth.set('pending', input.pending);
  webhookQueueDepth.set('retrying', input.retrying);
  webhookQueueDepth.set('paused', input.paused);
  webhookOldestJobAgeSeconds = input.oldestAgeSeconds;
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
    '# HELP control_plane_approval_inbox_queries_total Workspace approval inbox queries by status filter and outcome.',
    '# TYPE control_plane_approval_inbox_queries_total counter',
    ...Array.from(approvalInboxQueries.entries()).map(([key, value]) => {
      const [status, outcome] = key.split(':');
      return metricLine('control_plane_approval_inbox_queries_total', { ...serviceLabels, status, outcome }, value);
    }),
    '# HELP control_plane_approval_inbox_query_duration_ms_bucket Workspace approval inbox query duration buckets by status filter and outcome.',
    '# TYPE control_plane_approval_inbox_query_duration_ms_bucket counter',
    ...Array.from(approvalInboxQueryDurations.entries()).map(([key, value]) => {
      const [status, outcome, le] = key.split(':');
      return metricLine('control_plane_approval_inbox_query_duration_ms_bucket', { ...serviceLabels, status, outcome, le }, value);
    }),
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
    ),
    '# HELP control_plane_workflow_repository_failures_total Durable agent and workflow repository failures by safe operation.',
    '# TYPE control_plane_workflow_repository_failures_total counter',
    ...Array.from(workflowRepositoryFailures.entries()).map(([key, value]) => {
      const [repository, operation] = key.split(':');
      return metricLine('control_plane_workflow_repository_failures_total', { ...serviceLabels, repository, operation }, value);
    }),
    '# HELP control_plane_workflow_catalog_source_total Workflow catalog source outcomes.',
    '# TYPE control_plane_workflow_catalog_source_total counter',
    ...Array.from(workflowCatalogSourceAvailability.entries()).map(([key, value]) => {
      const [source, status] = key.split(':');
      return metricLine('control_plane_workflow_catalog_source_total', { ...serviceLabels, source, status }, value);
    }),
    '# HELP control_plane_workflow_schedule_preview_duration_ms_bucket Schedule preview latency buckets.',
    '# TYPE control_plane_workflow_schedule_preview_duration_ms_bucket counter',
    ...Array.from(workflowSchedulePreviewDurations.entries()).map(([key, value]) => {
      const [status, le] = key.split(':');
      return metricLine('control_plane_workflow_schedule_preview_duration_ms_bucket', { ...serviceLabels, status, le }, value);
    }),
    '# HELP control_plane_workflow_execution_stream_events_total Workflow execution SSE lifecycle and replay outcomes.',
    '# TYPE control_plane_workflow_execution_stream_events_total counter',
    ...Array.from(workflowExecutionStreams.entries()).map(([event, value]) =>
      metricLine('control_plane_workflow_execution_stream_events_total', { ...serviceLabels, event }, value)
    ),
    '# HELP control_plane_automation_dispatch_total Durable automation dispatch outcomes.',
    '# TYPE control_plane_automation_dispatch_total counter',
    ...Array.from(automationDispatches.entries()).map(([key, value]) => {
      const [source, outcome] = key.split(':');
      return metricLine('control_plane_automation_dispatch_total', { ...serviceLabels, source, outcome }, value);
    }),
    '# HELP control_plane_automation_dispatch_duration_ms_bucket Automation dispatch latency buckets.',
    '# TYPE control_plane_automation_dispatch_duration_ms_bucket counter',
    ...Array.from(automationDispatchDurations.entries()).map(([key, value]) => {
      const [source, outcome, le] = key.split(':');
      return metricLine('control_plane_automation_dispatch_duration_ms_bucket', { ...serviceLabels, source, outcome, le }, value);
    }),
    '# HELP control_plane_automation_trigger_total Durable trigger delivery outcomes.',
    '# TYPE control_plane_automation_trigger_total counter',
    ...Array.from(automationTriggers.entries()).map(([key, value]) => {
      const [triggerType, outcome] = key.split(':');
      return metricLine('control_plane_automation_trigger_total', { ...serviceLabels, trigger_type: triggerType, outcome }, value);
    }),
    '# HELP control_plane_automation_approval_total Durable automation approval outcomes.',
    '# TYPE control_plane_automation_approval_total counter',
    ...Array.from(automationApprovals.entries()).map(([key, value]) => {
      const [kind, outcome] = key.split(':');
      return metricLine('control_plane_automation_approval_total', { ...serviceLabels, kind, outcome }, value);
    }),
    '# HELP control_plane_automation_terminal_outcomes_total Agent and Workflow terminal outcomes.',
    '# TYPE control_plane_automation_terminal_outcomes_total counter',
    ...Array.from(automationTerminalOutcomes.entries()).map(([key, value]) => {
      const [source, status] = key.split(':');
      return metricLine('control_plane_automation_terminal_outcomes_total', { ...serviceLabels, source, status }, value);
    }),
    '# HELP control_plane_automation_pdf_render_total PDF render outcomes and output bytes.',
    '# TYPE control_plane_automation_pdf_render_total counter',
    ...Array.from(automationPdfRenders.entries()).map(([key, value]) => {
      const [outcome, measure] = key.split(':');
      return metricLine('control_plane_automation_pdf_render_total', { ...serviceLabels, outcome, measure }, value);
    }),
    '# HELP control_plane_automation_pdf_render_duration_ms_bucket PDF render latency buckets.',
    '# TYPE control_plane_automation_pdf_render_duration_ms_bucket counter',
    ...Array.from(automationPdfRenderDurations.entries()).map(([key, value]) => {
      const [outcome, le] = key.split(':');
      return metricLine('control_plane_automation_pdf_render_duration_ms_bucket', { ...serviceLabels, outcome, le }, value);
    }),
    '# HELP control_plane_automation_mcp_failures_total Automation MCP dependency failures by safe operation.',
    '# TYPE control_plane_automation_mcp_failures_total counter',
    ...Array.from(automationMcpFailures.entries()).map(([operation, value]) =>
      metricLine('control_plane_automation_mcp_failures_total', { ...serviceLabels, operation }, value)
    ),
    '# HELP control_plane_automation_runtime Automation runtime gauges; labels identify the measured resource and state.',
    '# TYPE control_plane_automation_runtime gauge',
    ...Object.entries(automationGauges).map(([key, value]) => {
      const [resource, state = 'all'] = key.split(':');
      return metricLine('control_plane_automation_runtime', { ...serviceLabels, resource, state }, value);
    }),
    '# HELP control_plane_tool_result_artifact_events_total Tool result artifact lifecycle outcomes.',
    '# TYPE control_plane_tool_result_artifact_events_total counter',
    ...Array.from(toolResultArtifactEvents.entries()).map(([event, value]) =>
      metricLine('control_plane_tool_result_artifact_events_total', { ...serviceLabels, event }, value)
    ),
    '# HELP control_plane_tool_result_artifact_bytes Tool result artifact size by stored view.',
    '# TYPE control_plane_tool_result_artifact_bytes histogram',
    ...Array.from(toolResultArtifactSizes.entries()).map(([key, value]) => {
      const [view, le] = key.split(':');
      return metricLine('control_plane_tool_result_artifact_bytes_bucket', { ...serviceLabels, view, le }, value);
    }),
    ...Array.from(toolResultArtifactSizeSums.entries()).map(([view, value]) =>
      metricLine('control_plane_tool_result_artifact_bytes_sum', { ...serviceLabels, view }, value)
    ),
    ...Array.from(toolResultArtifactSizeCounts.entries()).map(([view, value]) =>
      metricLine('control_plane_tool_result_artifact_bytes_count', { ...serviceLabels, view }, value)
    ),
    '# HELP control_plane_external_webhook_route_requests_total External webhook route connect/status requests by operation and status.',
    '# TYPE control_plane_external_webhook_route_requests_total counter',
    ...Array.from(externalWebhookRouteRequests.entries()).map(([key, value]) => {
      const [operation, status] = key.split(':');
      return metricLine('control_plane_external_webhook_route_requests_total', { ...serviceLabels, operation, status }, value);
    }),
    '# HELP control_plane_external_webhook_route_secret_rotations_total Webhook signing secrets rotated by external route connect.',
    '# TYPE control_plane_external_webhook_route_secret_rotations_total counter',
    metricLine('control_plane_external_webhook_route_secret_rotations_total', serviceLabels, externalWebhookRouteSecretRotations),
    '# HELP control_plane_webhook_events_enqueued_total Durable webhook events enqueued by event type.',
    '# TYPE control_plane_webhook_events_enqueued_total counter',
    ...Array.from(webhookEventsEnqueued.entries()).map(([eventType, value]) =>
      metricLine('control_plane_webhook_events_enqueued_total', { ...serviceLabels, event_type: eventType }, value)
    ),
    '# HELP control_plane_webhook_delivery_attempts_total Webhook delivery attempts by low-cardinality outcome.',
    '# TYPE control_plane_webhook_delivery_attempts_total counter',
    ...Array.from(webhookDeliveryAttempts.entries()).map(([outcome, value]) =>
      metricLine('control_plane_webhook_delivery_attempts_total', { ...serviceLabels, outcome }, value)
    ),
    '# HELP control_plane_webhook_delivery_duration_ms_bucket Webhook delivery duration bucket counts by outcome.',
    '# TYPE control_plane_webhook_delivery_duration_ms_bucket counter',
    ...Array.from(webhookDeliveryDurations.entries()).map(([key, value]) => {
      const [outcome, le] = key.split(':');
      return metricLine('control_plane_webhook_delivery_duration_ms_bucket', { ...serviceLabels, outcome, le }, value);
    }),
    '# HELP control_plane_webhook_delivery_terminal_total Webhook retry and terminal transitions by status.',
    '# TYPE control_plane_webhook_delivery_terminal_total counter',
    ...Array.from(webhookDeliveryTerminal.entries()).map(([status, value]) =>
      metricLine('control_plane_webhook_delivery_terminal_total', { ...serviceLabels, status }, value)
    ),
    '# HELP control_plane_webhook_oversize_rejections_total Webhook event envelopes rejected for exceeding the size limit.',
    '# TYPE control_plane_webhook_oversize_rejections_total counter',
    metricLine('control_plane_webhook_oversize_rejections_total', serviceLabels, webhookOversizeRejections),
    '# HELP control_plane_webhook_jobs Webhook jobs by nonterminal queue state.',
    '# TYPE control_plane_webhook_jobs gauge',
    ...Array.from(webhookQueueDepth.entries()).map(([status, value]) =>
      metricLine('control_plane_webhook_jobs', { ...serviceLabels, status }, value)
    ),
    '# HELP control_plane_webhook_oldest_job_age_seconds Age of the oldest nonterminal webhook job.',
    '# TYPE control_plane_webhook_oldest_job_age_seconds gauge',
    metricLine('control_plane_webhook_oldest_job_age_seconds', serviceLabels, webhookOldestJobAgeSeconds),
    '# HELP control_plane_webhook_lease_recoveries_total Expired webhook processing leases reclaimed.',
    '# TYPE control_plane_webhook_lease_recoveries_total counter',
    metricLine('control_plane_webhook_lease_recoveries_total', serviceLabels, webhookLeaseRecoveries)
  ];
  return `${lines.join('\n')}\n`;
}
