import { config } from '../config.js';
import type {
  WorkflowEventTriggerRecord,
  WorkflowExecutionSummary
} from '../types/workflows.js';

export function workflowEventTriggerEndpointUrl(triggerId: string): string {
  const base = config.CONTROL_PLANE_BASE_URL.replace(/\/+$/, '');
  return `${base}/api/v1/workflow-event-triggers/${encodeURIComponent(triggerId)}/events`;
}

export function publicWorkflowEventTrigger(
  trigger: WorkflowEventTriggerRecord,
  latestExecution: WorkflowExecutionSummary | null = null
): Record<string, unknown> {
  return {
    id: trigger.id,
    workspaceId: trigger.workspaceId,
    workflowId: trigger.workflowId,
    name: trigger.name,
    status: trigger.status,
    sourceType: trigger.sourceType,
    eventType: trigger.eventType || null,
    inputBindings: trigger.inputBindings,
    approvedContextGrants: trigger.approvedContextGrants,
    principal: trigger.principal,
    ...(trigger.sourceType === 'webhook'
      ? { endpointUrl: workflowEventTriggerEndpointUrl(trigger.id) }
      : {}),
    lastTriggeredAt: trigger.lastTriggeredAt || null,
    lastStatus: trigger.lastStatus || null,
    lastExecutionId: trigger.lastExecutionId || null,
    lastRunId: trigger.lastRunId || null,
    latestExecution,
    lastError: trigger.lastError || null
  };
}
