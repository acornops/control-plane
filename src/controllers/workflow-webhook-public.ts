import { config } from '../config.js';
import type {
  WorkflowWebhookRecord,
  WorkflowExecutionSummary
} from '../types/workflows.js';

export function workflowWebhookEndpointUrl(webhookId: string): string {
  const base = config.CONTROL_PLANE_BASE_URL.replace(/\/+$/, '');
  return `${base}/api/v1/workflow-webhooks/${encodeURIComponent(webhookId)}/events`;
}

export function publicWorkflowWebhook(
  webhook: WorkflowWebhookRecord,
  latestExecution: WorkflowExecutionSummary | null = null
): Record<string, unknown> {
  return {
    id: webhook.id,
    workspaceId: webhook.workspaceId,
    workflowId: webhook.workflowId,
    name: webhook.name,
    status: webhook.status,
    principal: webhook.principal,
    endpointUrl: workflowWebhookEndpointUrl(webhook.id),
    lastReceivedAt: webhook.lastReceivedAt || null,
    lastStatus: webhook.lastStatus || null,
    lastExecutionId: webhook.lastExecutionId || null,
    lastRunId: webhook.lastRunId || null,
    latestExecution,
    lastError: webhook.lastError || null
  };
}
