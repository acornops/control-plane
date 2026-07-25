import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import {
  claimWorkflowEventTriggerDeliveries,
  finishWorkflowEventTriggerDelivery,
  getWorkflowEventTrigger,
  type ClaimedWorkflowEventTriggerDelivery
} from '../store/repository-workflow-event-triggers.js';
import { getWorkflowExecutionByTriggerOccurrence } from '../store/repository-workflows.js';
import type { WorkflowEventInputBinding } from '../types/workflows.js';
import { withRedisLease } from './control-plane-coordination/leases.js';
import {
  dispatchWorkflowTrigger,
  sanitizeWorkflowTriggerError
} from './workflow-trigger-dispatch.js';

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
}

function issueBindingValue(payload: Record<string, unknown>, binding: WorkflowEventInputBinding): string {
  const issue = nestedRecord(payload, 'issue');
  const target = nestedRecord(payload, 'target');
  const values: Record<WorkflowEventInputBinding, unknown> = {
    'issue.id': issue.id,
    'issue.title': issue.title,
    'issue.summary': issue.summary,
    'issue.severity': issue.severity,
    'issue.scope': issue.scope,
    'issue.object': issue.object,
    'target.id': target.id,
    'target.type': target.type
  };
  const value = values[binding];
  return typeof value === 'string' ? value : '';
}

function deliveryInputs(delivery: ClaimedWorkflowEventTriggerDelivery): Record<string, string> {
  if (delivery.trigger.sourceType === 'webhook') {
    const inputs = nestedRecord(delivery.payload, 'inputs');
    return Object.fromEntries(
      Object.entries(inputs).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  }
  return Object.fromEntries(
    Object.entries(delivery.trigger.inputBindings).map(([key, binding]) => [
      key,
      issueBindingValue(delivery.payload, binding)
    ])
  );
}

async function auditDispatch(
  delivery: ClaimedWorkflowEventTriggerDelivery,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: delivery.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorUserId: delivery.trigger.principal.id,
    objectType: 'workflow_event_trigger',
    objectId: delivery.trigger.id,
    objectName: delivery.trigger.name,
    summary,
    metadata: {
      workflowId: delivery.trigger.workflowId,
      sourceType: delivery.trigger.sourceType,
      sourceEventType: delivery.eventType,
      eventId: delivery.eventId,
      occurrenceKey: delivery.occurrenceKey,
      ...metadata
    }
  });
}

async function processDelivery(delivery: ClaimedWorkflowEventTriggerDelivery): Promise<void> {
  let effectiveDelivery = delivery;
  try {
    const existing = await getWorkflowExecutionByTriggerOccurrence(
      delivery.workspaceId,
      delivery.trigger.id,
      delivery.occurrenceKey
    );
    if (existing) {
      await finishWorkflowEventTriggerDelivery({
        delivery,
        status: 'delivered',
        triggerStatus: 'dispatched',
        executionId: existing.execution.id,
        runId: existing.run.id
      });
      await auditDispatch(
        delivery,
        'workflow.event_trigger_dispatched.v1',
        'Workflow event trigger dispatched',
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
    const currentTrigger = await getWorkflowEventTrigger(delivery.trigger.id);
    if (!currentTrigger || currentTrigger.status !== 'enabled') {
      await finishWorkflowEventTriggerDelivery({
        delivery,
        status: 'rejected',
        triggerStatus: 'rejected',
        error: currentTrigger ? 'Event trigger was paused before dispatch.' : 'Event trigger was deleted before dispatch.'
      });
      return;
    }
    effectiveDelivery = { ...delivery, trigger: currentTrigger };
    const dispatch = await dispatchWorkflowTrigger({
      id: currentTrigger.id,
      workspaceId: delivery.workspaceId,
      workflowId: currentTrigger.workflowId,
      parameterSignature: currentTrigger.parameterSignature,
      inputs: deliveryInputs(effectiveDelivery),
      approvedContextGrants: currentTrigger.approvedContextGrants,
      principal: currentTrigger.principal,
      triggerType: currentTrigger.sourceType,
      occurrenceKey: delivery.occurrenceKey
    });
    if (dispatch.outcome === 'auto_paused') {
      const inputRejected = dispatch.reason === 'input_invalid';
      await finishWorkflowEventTriggerDelivery({
        delivery: effectiveDelivery,
        status: 'rejected',
        triggerStatus: inputRejected ? 'rejected' : 'auto_paused',
        error: dispatch.error,
        pauseTrigger: !inputRejected
      });
      await auditDispatch(
        effectiveDelivery,
        inputRejected
          ? 'workflow.event_trigger_rejected.v1'
          : 'workflow.event_trigger_auto_paused.v1',
        inputRejected
          ? 'Workflow event trigger input rejected'
          : 'Workflow event trigger auto-paused',
        { reason: dispatch.reason }
      );
      return;
    }
    await finishWorkflowEventTriggerDelivery({
      delivery: effectiveDelivery,
      status: 'delivered',
      triggerStatus: 'dispatched',
      executionId: dispatch.executionId,
      runId: dispatch.runId
    });
    await auditDispatch(
      effectiveDelivery,
      'workflow.event_trigger_dispatched.v1',
      'Workflow event trigger dispatched',
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
    await finishWorkflowEventTriggerDelivery({
      delivery: effectiveDelivery,
      status: retriesExhausted ? 'rejected' : 'failed',
      triggerStatus: retriesExhausted ? 'rejected' : 'failed',
      error: retriesExhausted ? 'Trigger delivery retries exhausted.' : message
    });
    logger.warn(
      { error, deliveryId: effectiveDelivery.id, triggerId: effectiveDelivery.trigger.id },
      'Workflow event trigger delivery failed'
    );
  }
}

export async function runWorkflowEventTriggerTick(limit = 25): Promise<number> {
  return (await withRedisLease('workflow-event-triggers', 30, async () => {
    const claimOwner = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
    const deliveries = await claimWorkflowEventTriggerDeliveries(limit, claimOwner);
    for (const delivery of deliveries) {
      await processDelivery(delivery);
    }
    return deliveries.length;
  })) || 0;
}
