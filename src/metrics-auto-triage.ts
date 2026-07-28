import { increment, metricLine } from './metrics-helpers.js';

const queuedJobs = new Map<string, number>();
const jobOutcomes = new Map<string, number>();
const blockedReasons = new Map<string, number>();
const startLatencyBuckets = new Map<string, number>();
const runtimeEvents = new Map<string, number>();
let activeRuns = 0;

export function incrementAutoTriageQueued(triggerReason: string): void {
  increment(queuedJobs, triggerReason);
}

export function incrementAutoTriageOutcome(outcome: string): void {
  increment(jobOutcomes, outcome);
}

export function incrementAutoTriageBlocked(reason: string): void {
  increment(blockedReasons, reason);
}

export function observeAutoTriageStartLatencyMs(durationMs: number): void {
  for (const bucket of [1000, 5000, 15000, 30000, 60000, 300000, Number.POSITIVE_INFINITY]) {
    if (durationMs <= bucket) increment(startLatencyBuckets, String(bucket));
  }
}

export function incrementAutoTriageRuntimeEvent(
  event: 'session_created' | 'dispatch_retry' | 'dispatch_failed' | 'resolution_stopped'
): void {
  increment(runtimeEvents, event);
}

export function setAutoTriageActiveRuns(count: number): void {
  activeRuns = Math.max(0, Math.floor(count));
}

export function renderAutoTriageMetrics(serviceLabels: Record<string, string>): string[] {
  return [
    '# HELP control_plane_auto_triage_jobs_queued_total Automatic investigation jobs queued by bounded trigger reason.',
    '# TYPE control_plane_auto_triage_jobs_queued_total counter',
    ...Array.from(queuedJobs.entries()).map(([triggerReason, value]) =>
      metricLine('control_plane_auto_triage_jobs_queued_total', { ...serviceLabels, trigger_reason: triggerReason }, value)
    ),
    '# HELP control_plane_auto_triage_job_outcomes_total Automatic investigation job outcomes.',
    '# TYPE control_plane_auto_triage_job_outcomes_total counter',
    ...Array.from(jobOutcomes.entries()).map(([outcome, value]) =>
      metricLine('control_plane_auto_triage_job_outcomes_total', { ...serviceLabels, outcome }, value)
    ),
    '# HELP control_plane_auto_triage_blocked_total Automatic investigation readiness and dispatch blockers.',
    '# TYPE control_plane_auto_triage_blocked_total counter',
    ...Array.from(blockedReasons.entries()).map(([reason, value]) =>
      metricLine('control_plane_auto_triage_blocked_total', { ...serviceLabels, reason }, value)
    ),
    '# HELP control_plane_auto_triage_start_latency_ms_bucket Queue-to-run-start latency buckets.',
    '# TYPE control_plane_auto_triage_start_latency_ms_bucket counter',
    ...Array.from(startLatencyBuckets.entries()).map(([le, value]) =>
      metricLine('control_plane_auto_triage_start_latency_ms_bucket', { ...serviceLabels, le }, value)
    ),
    '# HELP control_plane_auto_triage_runtime_events_total Automatic investigation session, dispatch, and resolution events.',
    '# TYPE control_plane_auto_triage_runtime_events_total counter',
    ...Array.from(runtimeEvents.entries()).map(([event, value]) =>
      metricLine('control_plane_auto_triage_runtime_events_total', { ...serviceLabels, event }, value)
    ),
    '# HELP control_plane_auto_triage_active_runs Current nonterminal automatic investigation runs.',
    '# TYPE control_plane_auto_triage_active_runs gauge',
    metricLine('control_plane_auto_triage_active_runs', serviceLabels, activeRuns)
  ];
}
