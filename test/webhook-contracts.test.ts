import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema
} from '../src/types/contracts.js';

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
