import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema
} from '../src/types/contracts.js';
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
