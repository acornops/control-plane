import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import {
  claimWorkflowWebhookDeliveries,
  finishWorkflowWebhookDelivery,
  getWorkflowWebhook,
  type ClaimedWorkflowWebhookDelivery
} from '../store/repository-workflow-webhooks.js';
import { getWorkflowExecutionByTriggerOccurrence } from '../store/repository-workflows.js';
import { withRedisLease } from './control-plane-coordination/leases.js';
import {
  dispatchWorkflowTrigger,
  sanitizeWorkflowTriggerError
} from './workflow-trigger-dispatch.js';

async function auditDispatch(
  delivery: ClaimedWorkflowWebhookDelivery,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: delivery.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorUserId: delivery.webhook.principal.id,
    objectType: 'workflow_webhook',
    objectId: delivery.webhook.id,
    objectName: delivery.webhook.name,
    summary,
    metadata: {
      workflowId: delivery.webhook.workflowId,
      eventId: delivery.eventId,
      occurrenceKey: delivery.occurrenceKey,
      ...metadata
    }
  });
}

async function processDelivery(delivery: ClaimedWorkflowWebhookDelivery): Promise<void> {
  let effectiveDelivery = delivery;
  try {
    const existing = await getWorkflowExecutionByTriggerOccurrence(
      delivery.workspaceId,
      delivery.webhook.id,
      delivery.occurrenceKey
    );
    if (existing) {
      await finishWorkflowWebhookDelivery({
        delivery,
        status: 'delivered',
        webhookStatus: 'dispatched',
        executionId: existing.execution.id,
        runId: existing.run.id
      });
      await auditDispatch(
        delivery,
        'workflow.webhook_dispatched.v1',
        'Workflow webhook dispatched',
        {
          executionId: existing.execution.id,
          runId: existing.run.id,
          waitingForApproval: existing.run.status === 'waiting_for_approval',
          runtimeSubject: existing.compiledAccessScope.actor,
          recoveredDelivery: true
        }
      );
      return;
    }
    const currentWebhook = await getWorkflowWebhook(delivery.webhook.id);
    if (!currentWebhook || currentWebhook.status !== 'enabled') {
      await finishWorkflowWebhookDelivery({
        delivery,
        status: 'rejected',
        webhookStatus: 'rejected',
        error: currentWebhook ? 'Workflow webhook was paused before dispatch.' : 'Workflow webhook was deleted before dispatch.'
      });
      return;
    }
    effectiveDelivery = { ...delivery, webhook: currentWebhook };
    const dispatch = await dispatchWorkflowTrigger({
      id: currentWebhook.id,
      name: currentWebhook.name,
      workspaceId: delivery.workspaceId,
      workflowId: currentWebhook.workflowId,
      principal: currentWebhook.principal,
      triggerType: 'webhook',
      occurrenceKey: delivery.occurrenceKey
    });
    if (dispatch.outcome === 'auto_paused') {
      const definitionRejected = dispatch.reason === 'workflow_definition_invalid';
      await finishWorkflowWebhookDelivery({
        delivery: effectiveDelivery,
        status: 'rejected',
        webhookStatus: definitionRejected ? 'rejected' : 'auto_paused',
        error: dispatch.error,
        pauseWebhook: !definitionRejected
      });
      await auditDispatch(
        effectiveDelivery,
        definitionRejected
          ? 'workflow.webhook_rejected.v1'
          : 'workflow.webhook_auto_paused.v1',
        definitionRejected
          ? 'Workflow webhook definition rejected'
          : 'Workflow webhook auto-paused',
        { reason: dispatch.reason }
      );
      return;
    }
    await finishWorkflowWebhookDelivery({
      delivery: effectiveDelivery,
      status: 'delivered',
      webhookStatus: 'dispatched',
      executionId: dispatch.executionId,
      runId: dispatch.runId
    });
    await auditDispatch(
      effectiveDelivery,
      'workflow.webhook_dispatched.v1',
      'Workflow webhook dispatched',
      {
        executionId: dispatch.executionId,
        runId: dispatch.runId,
        waitingForApproval: dispatch.waitingForApproval,
        runtimeSubject: dispatch.runtimeSubject
      }
    );
  } catch (error) {
    const message = sanitizeWorkflowTriggerError(error);
    const retriesExhausted = delivery.attemptCount + 1 >= 3;
    await finishWorkflowWebhookDelivery({
      delivery: effectiveDelivery,
      status: retriesExhausted ? 'rejected' : 'failed',
      webhookStatus: retriesExhausted ? 'rejected' : 'failed',
      error: retriesExhausted ? 'Webhook delivery retries exhausted.' : message
    });
    logger.warn(
      { error, deliveryId: effectiveDelivery.id, webhookId: effectiveDelivery.webhook.id },
      'Workflow webhook delivery failed'
    );
  }
}

export async function runWorkflowWebhookTick(limit = 25): Promise<number> {
  return (await withRedisLease('workflow-webhooks', 30, async () => {
    const claimOwner = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
    const deliveries = await claimWorkflowWebhookDeliveries(limit, claimOwner);
    for (const delivery of deliveries) {
      await processDelivery(delivery);
    }
    return deliveries.length;
  })) || 0;
}
