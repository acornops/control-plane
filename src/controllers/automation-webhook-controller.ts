import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { incrementAutomationTrigger } from '../metrics.js';
import { withTransaction } from '../store/repository-transaction.js';
import { decryptWebhookSecret, signWebhookPayload } from '../utils/crypto.js';
import { toSingleParam } from '../utils/params.js';
import { badRequest } from './agent-controller-helpers.js';

function constantTimeHexEqual(actual: string, expected: string): boolean {
  const normalized = actual.startsWith('sha256=') ? actual.slice(7) : actual;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return false;
  const left = Buffer.from(normalized, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function receiveAgentWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawBody = (req as Request & { rawBody?: string }).rawBody || '';
    if (Buffer.byteLength(rawBody) > 256 * 1024) {
      incrementAutomationTrigger('webhook', 'payload_rejected');
      res.status(413).json({ error: { code: 'WEBHOOK_PAYLOAD_TOO_LARGE', message: 'Webhook payload exceeds 256 KiB.', retryable: false } });
      return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      badRequest(res, 'WEBHOOK_PAYLOAD_INVALID', 'Webhook payload must be a JSON object.');
      return;
    }
    const timestamp = req.header('x-acornops-timestamp') || '';
    const signature = req.header('x-acornops-signature') || '';
    const eventId = (req.header('x-acornops-event-id') || '').trim();
    const timestampMs = /^\d+$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      incrementAutomationTrigger('webhook', 'timestamp_rejected');
      res.status(401).json({ error: { code: 'WEBHOOK_TIMESTAMP_INVALID', message: 'Webhook timestamp is outside the five-minute acceptance window.', retryable: false } });
      return;
    }
    if (!eventId || eventId.length > 200) {
      badRequest(res, 'WEBHOOK_EVENT_ID_REQUIRED', 'x-acornops-event-id is required and must not exceed 200 characters.');
      return;
    }
    const triggerResult = await db.query<QueryResultRow>(
      `SELECT * FROM agent_triggers WHERE id=$1 AND type='webhook' AND enabled=true`,
      [toSingleParam(req.params.triggerId)]
    );
    const trigger = triggerResult.rows[0];
    if (!trigger || !trigger.secret_ciphertext) {
      res.status(404).json({ error: { code: 'WEBHOOK_NOT_FOUND', message: 'Webhook trigger not found.', retryable: false } });
      return;
    }
    const expected = signWebhookPayload(decryptWebhookSecret(trigger.secret_ciphertext), timestamp, rawBody);
    if (!constantTimeHexEqual(signature, expected)) {
      incrementAutomationTrigger('webhook', 'signature_rejected');
      res.status(401).json({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Webhook signature is invalid.', retryable: false } });
      return;
    }
    const recent = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM automation_trigger_events
       WHERE workspace_id=$1 AND source_type='webhook' AND source_id=$2 AND created_at > NOW()-INTERVAL '1 minute'`,
      [trigger.workspace_id, trigger.id]
    );
    if (Number(recent.rows[0]?.count || 0) >= 60) {
      incrementAutomationTrigger('webhook', 'rate_limited');
      res.status(429).json({ error: { code: 'WEBHOOK_RATE_LIMITED', message: 'Webhook trigger rate limit exceeded.', retryable: true } });
      return;
    }
    const eventInternalId = randomUUID();
    const accepted = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO automation_trigger_events
          (id,workspace_id,event_type,source_type,source_id,occurrence_key,payload,occurred_at)
         VALUES ($1,$2,'agent.webhook.received.v1','webhook',$3,$4,$5,$6)
         ON CONFLICT (workspace_id,source_type,source_id,occurrence_key) DO NOTHING RETURNING id`,
        [eventInternalId, trigger.workspace_id, trigger.id, eventId, req.body, new Date(timestampMs).toISOString()]
      );
      if (!inserted.rowCount) return false;
      await client.query(
        `INSERT INTO automation_trigger_deliveries (id,event_id,workspace_id,trigger_id,status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [randomUUID(), eventInternalId, trigger.workspace_id, trigger.id]
      );
      return true;
    });
    if (!accepted) {
      incrementAutomationTrigger('webhook', 'replayed');
      res.status(409).json({ error: { code: 'WEBHOOK_REPLAYED', message: 'This webhook event ID was already accepted.', retryable: false } });
      return;
    }
    incrementAutomationTrigger('webhook', 'accepted');
    res.status(202).json({ eventId, status: 'accepted' });
  } catch (err) {
    next(err);
  }
}
