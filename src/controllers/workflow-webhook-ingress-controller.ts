import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { redis } from '../infra/redis.js';
import {
  acceptWorkflowWebhookEvent,
  getWorkflowWebhook
} from '../store/repository-workflow-webhooks.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import type { WorkflowParameterDefinition } from '../types/workflows.js';
import {
  decryptWebhookSecret,
  signWebhookPayload
} from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import { workflowParameterSignature } from '../services/workflow-template.js';

const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;
const MAX_WEBHOOK_EVENTS_PER_MINUTE = 60;
const MAX_WEBHOOK_ATTEMPTS_PER_MINUTE = 120;

function objectBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

export function constantTimeSignatureEqual(actual: string, expected: string): boolean {
  const normalized = actual.startsWith('v1=')
    ? actual.slice(3)
    : actual.startsWith('sha256=')
      ? actual.slice(7)
      : actual;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return false;
  const left = Buffer.from(normalized, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function webhookInputsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((input) => typeof input === 'string');
}

export function validateWebhookInputs(
  parameters: WorkflowParameterDefinition[],
  value: unknown
): string | null {
  if (!webhookInputsValid(value)) {
    return 'Webhook payload must contain an inputs object with string values.';
  }
  const inputs = value as Record<string, string>;
  const expected = new Set(parameters.map((parameter) => parameter.key));
  for (const parameter of parameters) {
    if (!Object.hasOwn(inputs, parameter.key)) return `${parameter.key} is required.`;
    if (!inputs[parameter.key].trim()) return `${parameter.key} cannot be empty.`;
  }
  const unknown = Object.keys(inputs).find((key) => !expected.has(key));
  return unknown ? `${unknown.slice(0, 64)} is not declared by this workflow.` : null;
}

async function webhookAttemptRateLimited(webhookId: string): Promise<boolean> {
  const count = Number(await redis.eval(
    `local current = redis.call('INCR', KEYS[1])
     if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
     return current`,
    1,
    `cp:workflow_webhook_attempts:${webhookId}`,
    60
  ));
  return count > MAX_WEBHOOK_ATTEMPTS_PER_MINUTE;
}

export async function receiveWorkflowWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawBody = (req as Request & { rawBody?: string }).rawBody || '';
    if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_PAYLOAD_BYTES) {
      res.status(413).json({ error: {
        code: 'WEBHOOK_PAYLOAD_TOO_LARGE',
        message: 'Webhook payload exceeds 256 KiB.',
        retryable: false
      } });
      return;
    }
    const body = objectBody(req);
    if (!webhookInputsValid(body.inputs)) {
      res.status(400).json({ error: {
        code: 'WEBHOOK_PAYLOAD_INVALID',
        message: 'Webhook payload must contain an inputs object with string values.',
        retryable: false
      } });
      return;
    }
    const timestamp = (req.header('x-acornops-timestamp') || '').trim();
    const signature = (req.header('x-acornops-signature') || '').trim();
    const eventId = (req.header('x-acornops-event-id') || '').trim();
    const timestampMs = /^\d+$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      res.status(401).json({ error: {
        code: 'WEBHOOK_TIMESTAMP_INVALID',
        message: 'Webhook timestamp is outside the five-minute acceptance window.',
        retryable: false
      } });
      return;
    }
    if (!eventId || eventId.length > 200) {
      res.status(400).json({ error: {
        code: 'WEBHOOK_EVENT_ID_REQUIRED',
        message: 'X-AcornOps-Event-Id is required and must not exceed 200 characters.',
        retryable: false
      } });
      return;
    }
    const webhook = await getWorkflowWebhook(toSingleParam(req.params.webhookId));
    if (
      !webhook
      || webhook.status !== 'enabled'
    ) {
      res.status(404).json({ error: {
        code: 'WEBHOOK_NOT_FOUND',
        message: 'Workflow webhook not found.',
        retryable: false
      } });
      return;
    }
    if (await webhookAttemptRateLimited(webhook.id)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: {
        code: 'WEBHOOK_ATTEMPT_RATE_LIMITED',
        message: 'Workflow webhook attempt rate limit exceeded.',
        retryable: true
      } });
      return;
    }
    const expected = signWebhookPayload(decryptWebhookSecret(webhook.secretCiphertext), timestamp, rawBody);
    if (!constantTimeSignatureEqual(signature, expected)) {
      res.status(401).json({ error: {
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Webhook signature is invalid.',
        retryable: false
      } });
      return;
    }
    const workflow = await getWorkflowDefinition(webhook.workspaceId, webhook.workflowId);
    if (
      !workflow
      || webhook.parameterSignature !== workflowParameterSignature(workflow.parameters)
    ) {
      res.status(409).json({ error: {
        code: 'WEBHOOK_WORKFLOW_CHANGED',
        message: 'The target workflow changed. Review and save this workflow webhook before retrying.',
        retryable: false
      } });
      return;
    }
    const inputError = validateWebhookInputs(workflow.parameters, body.inputs);
    if (inputError) {
      res.status(400).json({ error: {
        code: 'WEBHOOK_INPUTS_INVALID',
        message: inputError,
        retryable: false
      } });
      return;
    }
    const accepted = await acceptWorkflowWebhookEvent({
      webhook,
      eventId,
      occurredAt: new Date(timestampMs).toISOString(),
      payload: body,
      maxEventsPerMinute: MAX_WEBHOOK_EVENTS_PER_MINUTE
    });
    if (accepted === 'inactive') {
      res.status(404).json({ error: {
        code: 'WEBHOOK_NOT_FOUND',
        message: 'Workflow webhook not found.',
        retryable: false
      } });
      return;
    }
    if (accepted === 'rate_limited') {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: {
        code: 'WEBHOOK_RATE_LIMITED',
        message: 'Workflow webhook rate limit exceeded.',
        retryable: true
      } });
      return;
    }
    res.status(202).json({ eventId, status: 'accepted' });
  } catch (error) {
    next(error);
  }
}
