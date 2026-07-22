import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deliverWebhookRequest,
  resolveWebhookEndpoint,
  validateWebhookDeliveryUrl,
  WebhookDeliveryPolicyError
} from '../../src/services/webhook-delivery.js';

describe('webhook delivery policy', () => {
  it('applies the delivery timeout to DNS resolution as well as the HTTP exchange', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () => deliverWebhookRequest({
        url: 'https://hooks.example.com/events',
        method: 'POST',
        headers: {},
        body: '{}',
        timeoutMs: 20
      }, {
        resolveEndpoint: async () => await new Promise(() => undefined)
      }),
      /timed out after 20ms/
    );
    assert.ok(Date.now() - startedAt < 1000);
  });

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

  it('allows configured private hostname patterns while keeping public hosts additive', () => {
    const patterns = ['hooks.internal', '*.webhooks.example.com'];
    assert.equal(
      validateWebhookDeliveryUrl('https://hooks.internal/events', patterns).hostname,
      'hooks.internal'
    );
    assert.equal(
      validateWebhookDeliveryUrl('https://team.webhooks.example.com/events', patterns).hostname,
      'team.webhooks.example.com'
    );
    assert.equal(
      validateWebhookDeliveryUrl('https://public.example.net/events', patterns).hostname,
      'public.example.net'
    );
    assert.throws(
      () => validateWebhookDeliveryUrl('https://unlisted.internal/events', patterns),
      WebhookDeliveryPolicyError
    );
  });

  it('rejects direct private, link-local, and documentation addresses', async () => {
    await assert.rejects(() => resolveWebhookEndpoint('https://93.184.216.34/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://127.0.0.1/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://169.254.169.254/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://192.168.1.10/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://[::1]/hook'), WebhookDeliveryPolicyError);
    await assert.rejects(() => resolveWebhookEndpoint('https://[2001:db8::1]/hook'), WebhookDeliveryPolicyError);
  });

  it('allows private DNS answers only for configured exact and wildcard hostnames', async () => {
    const lookup = async () => [{ address: '10.20.30.40', family: 4 }];
    await assert.doesNotReject(() => resolveWebhookEndpoint('https://hooks.example.com/events', {
      allowedPrivateHosts: ['hooks.example.com'],
      lookup
    }));
    await assert.doesNotReject(() => resolveWebhookEndpoint('https://team.hooks.example.com/events', {
      allowedPrivateHosts: ['*.hooks.example.com'],
      lookup
    }));
    await assert.rejects(() => resolveWebhookEndpoint('https://other.example.com/events', {
      allowedPrivateHosts: ['hooks.example.com'],
      lookup
    }), WebhookDeliveryPolicyError);
  });

  it('continues to allow public IPv4 destinations without private host configuration', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    await assert.doesNotReject(() => resolveWebhookEndpoint('https://public.example.com/events', { lookup }));
  });

  it('allows IPv6 unique-local destinations only for configured hostnames', async () => {
    const lookup = async () => [{ address: 'fd00::40', family: 6 }];
    await assert.doesNotReject(() => resolveWebhookEndpoint('https://hooks.example.com/events', {
      allowedPrivateHosts: ['hooks.example.com'],
      lookup
    }));
    await assert.rejects(() => resolveWebhookEndpoint('https://other.example.com/events', { lookup }),
      WebhookDeliveryPolicyError);
  });

  it('treats shared address space as private and requires an allowed hostname', async () => {
    const lookup = async () => [{ address: '100.64.10.20', family: 4 }];
    await assert.doesNotReject(() => resolveWebhookEndpoint('https://hooks.example.com/events', {
      allowedPrivateHosts: ['hooks.example.com'],
      lookup
    }));
    await assert.rejects(() => resolveWebhookEndpoint('https://other.example.com/events', { lookup }),
      WebhookDeliveryPolicyError);
  });

  it('keeps hard-blocked DNS answers blocked for allowed hostnames', async () => {
    const lookup = async () => [
      { address: '10.20.30.40', family: 4 },
      { address: '169.254.169.254', family: 4 }
    ];
    await assert.rejects(() => resolveWebhookEndpoint('https://hooks.example.com/events', {
      allowedPrivateHosts: ['hooks.example.com'],
      lookup
    }), WebhookDeliveryPolicyError);
  });
});
