import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema,
  webhookEventTypes
} from '../src/types/contracts.js';
import { mapWebhookSubscription } from '../src/store/repository-webhook-mappers.js';
import { canonicalizeWebhookUrl } from '../src/utils/webhook-url.js';

const targetId = '5b006e4c-509c-458a-9f02-5aafbdc01ade';

test('webhook subscription validation uses targetId for target scope', () => {
  const parsed = createWebhookSubscriptionSchema.safeParse({
    name: 'PagerDuty',
    url: 'https://example.com/acornops/webhook',
    eventTypes: ['run.completed.v1'],
    targetId,
    enabled: true
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.targetId, targetId);
  }
});

test('webhook subscription validation rejects clusterId as a target scope field', () => {
  const parsed = createWebhookSubscriptionSchema.safeParse({
    name: 'PagerDuty',
    url: 'https://example.com/acornops/webhook',
    eventTypes: ['run.completed.v1'],
    clusterId: targetId,
    enabled: true
  });

  assert.equal(parsed.success, false);
});

test('webhook subscription updates reject unknown scope fields', () => {
  const parsed = updateWebhookSubscriptionSchema.safeParse({
    clusterId: targetId
  });

  assert.equal(parsed.success, false);
});

test('outbound webhook events exclude workspace creation', () => {
  assert.equal(webhookEventTypes.some((eventType) => eventType === 'workspace.created.v1'), false);
  assert.equal(webhookEventTypes.includes('workspace.deleted.v1'), true);
});

test('webhook subscription reads omit retired event types', () => {
  const subscription = mapWebhookSubscription({
    id: 'webhook-1',
    workspace_id: 'workspace-1',
    target_id: null,
    name: 'Operations',
    url: 'https://example.com/acornops/webhook',
    event_types: ['workspace.created.v1', 'run.failed.v1'],
    enabled: true,
    secret_ciphertext: 'ciphertext',
    secret_key_id: 'default',
    created_by: 'user-1',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z'
  });

  assert.deepEqual(subscription.eventTypes, ['run.failed.v1']);
});

test('webhook URL canonicalization normalizes host casing and root path', () => {
  assert.equal(
    canonicalizeWebhookUrl('https://BOT.EXAMPLE.com'),
    'https://bot.example.com/'
  );
});

test('webhook URL canonicalization normalizes existing mixed-case route URLs', () => {
  assert.equal(
    canonicalizeWebhookUrl('https://BOT.EXAMPLE.com/acornops/webhooks/routes/route-token'),
    'https://bot.example.com/acornops/webhooks/routes/route-token'
  );
});

test('webhook URL canonicalization rejects HTTP URLs', () => {
  assert.throws(
    () => canonicalizeWebhookUrl('http://bot.example.com/acornops/webhook'),
    /webhook URL must use https/
  );
});

test('webhook URL canonicalization rejects embedded credentials', () => {
  assert.throws(
    () => canonicalizeWebhookUrl('https://user:pass@bot.example.com/acornops/webhook'),
    /webhook URL must not include credentials/
  );
});
