import { increment, metricLine } from './metrics-helpers.js';

const workflowExecutionStreams = new Map<string, number>();

export function incrementWorkflowExecutionStream(
  event: 'opened' | 'closed' | 'replayed' | 'error',
  count = 1
): void {
  increment(workflowExecutionStreams, event, count);
}

export function renderWorkflowExecutionMetrics(serviceLabels: Record<string, string>): string[] {
  return [
    '# HELP control_plane_workflow_execution_stream_events_total Workflow execution SSE lifecycle and replay outcomes.',
    '# TYPE control_plane_workflow_execution_stream_events_total counter',
    ...Array.from(workflowExecutionStreams.entries()).map(([event, value]) =>
      metricLine('control_plane_workflow_execution_stream_events_total', { ...serviceLabels, event }, value)
    )
  ];
}
