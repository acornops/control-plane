import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';
import {
  normalizeWebhookPrivateHostPattern,
  parseWebhookAllowedPrivateHostsJson,
  webhookPrivateHostMatches
} from '../src/config-webhook-egress.js';

describe('webhook private hostname configuration', () => {
  it('normalizes exact and wildcard hostname patterns', () => {
    assert.equal(normalizeWebhookPrivateHostPattern('Hooks.Example.COM.'), 'hooks.example.com');
    assert.equal(normalizeWebhookPrivateHostPattern('*.Hooks.Example.COM.'), '*.hooks.example.com');
    assert.deepEqual(
      parseWebhookAllowedPrivateHostsJson('["hooks.example.com","HOOKS.EXAMPLE.COM"]'),
      ['hooks.example.com']
    );
  });

  it('matches exact hosts and wildcard descendants without matching the apex or lookalikes', () => {
    const patterns = ['hooks.example.com', '*.private.example.com'];
    assert.equal(webhookPrivateHostMatches('hooks.example.com', patterns), true);
    assert.equal(webhookPrivateHostMatches('a.private.example.com', patterns), true);
    assert.equal(webhookPrivateHostMatches('team.a.private.example.com', patterns), true);
    assert.equal(webhookPrivateHostMatches('private.example.com', patterns), false);
    assert.equal(webhookPrivateHostMatches('evilprivate.example.com', patterns), false);
  });

  it('rejects malformed, arbitrary, URL, port, and IP patterns', () => {
    for (const pattern of ['*', 'git*.example.com', 'https://example.com', 'example.com:8443', '10.0.0.1']) {
      assert.throws(() => normalizeWebhookPrivateHostPattern(pattern));
    }
    assert.throws(() => parseWebhookAllowedPrivateHostsJson('{}'));
    assert.throws(() => parseWebhookAllowedPrivateHostsJson('[1]'));
  });

  it('parses the runtime environment policy and reports invalid patterns on its field', () => {
    const config = parseAppConfig({
      NODE_ENV: 'development',
      WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON: '["hooks.internal","*.webhooks.example.com"]'
    });
    assert.deepEqual(config.WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS, [
      'hooks.internal',
      '*.webhooks.example.com'
    ]);
    assert.throws(
      () => parseAppConfig({ NODE_ENV: 'development', WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON: '["*"]' }),
      (error) => error instanceof ZodError &&
        Boolean(error.flatten().fieldErrors.WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON?.length)
    );
  });
});
