import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveWebhookEndpoint,
  validateWebhookDeliveryUrl,
  WebhookDeliveryPolicyError
} from '../../src/services/webhook-delivery.js';

describe('webhook delivery policy', () => {
  it('requires https webhook URLs without embedded credentials', () => {
    assert.throws(() => validateWebhookDeliveryUrl('http://example.com/hook'), WebhookDeliveryPolicyError);
    assert.throws(() => validateWebhookDeliveryUrl('https://user:pass@example.com/hook'), WebhookDeliveryPolicyError);
    assert.equal(validateWebhookDeliveryUrl('https://example.com/hook').toString(), 'https://example.com/hook');
  });

  it('blocks localhost and metadata-style hostnames before DNS resolution', () => {
    assert.throws(() => validateWebhookDeliveryUrl('https://localhost/hook'), WebhookDeliveryPolicyError);
    assert.throws(() => validateWebhookDeliveryUrl('https://api.local/hook'), WebhookDeliveryPolicyError);
    assert.throws(() => validateWebhookDeliveryUrl('https://metadata.google.internal/hook'), WebhookDeliveryPolicyError);
  });

  it('rejects direct private, link-local, and documentation addresses', async () => {
    await assert.rejects(() => resolveWebhookEndpoint('https://127.0.0.1/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://169.254.169.254/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://192.168.1.10/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://[::1]/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://[2001:db8::1]/hook'), WebhookDeliveryPolicyError);
  });
});
