import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertFetchUrlAllowed,
  canonicalizeFetchUrl,
  fetchUrlMatchesPattern,
  normalizeFetchToolInput,
  normalizeFetchToolConfig,
  normalizeFetchUrlPattern
} from '../../src/services/fetch-url-policy.js';

describe('Fetch URL policy', () => {
  it('normalizes hosts and default HTTPS ports while preserving case-sensitive paths and queries', () => {
    assert.equal(
      normalizeFetchUrlPattern(' https://API.Example.com:443/V1/*?q=* '),
      'https://api.example.com/V1/*?q=*'
    );
    assert.equal(
      canonicalizeFetchUrl('https://API.Example.com:443/V1/Payments?q=Open'),
      'https://api.example.com/V1/Payments?q=Open'
    );
  });

  it('supports anchored path and query wildcards across slash characters', () => {
    assert.equal(fetchUrlMatchesPattern(
      'https://api.example.com/v1/services/team/payments',
      'https://api.example.com/v1/services/*'
    ), true);
    assert.equal(fetchUrlMatchesPattern(
      'https://api.example.com/search?q=payments/active',
      'https://api.example.com/search?q=*'
    ), true);
    assert.equal(fetchUrlMatchesPattern(
      'https://api.example.com/v1/services',
      'https://api.example.com/v1/services/*'
    ), false);
    assert.equal(fetchUrlMatchesPattern(
      'https://lookalike.example.com/v1/services/payments',
      'https://api.example.com/v1/services/*'
    ), false);
    assert.equal(fetchUrlMatchesPattern(
      `https://api.example.com/${'a'.repeat(8_000)}`,
      `https://api.example.com/${'*a'.repeat(1_000)}*`
    ), true);
  });

  it('does not authorize an added query for an exact URL', () => {
    const config = normalizeFetchToolConfig({
      allowedUrlPatterns: ['https://status.example.com/api/health']
    });
    assert.equal(
      assertFetchUrlAllowed('https://status.example.com/api/health', config),
      'https://status.example.com/api/health'
    );
    assert.throws(
      () => assertFetchUrlAllowed('https://status.example.com/api/health?verbose=true', config),
      /not allowed/
    );
  });

  it('rejects malformed, unsafe, duplicate, and authority wildcard patterns', () => {
    for (const value of [
      'http://api.example.com/data',
      'https://user:secret@api.example.com/data',
      'https://api.example.com/data#fragment',
      'https://127.0.0.1/data',
      'https://*.example.com/data',
      'https://api.example.com:*/data',
      'not a url'
    ]) {
      assert.throws(() => normalizeFetchUrlPattern(value));
    }
    assert.throws(() => normalizeFetchToolConfig({
      allowedUrlPatterns: [
        'https://API.example.com:443/data',
        'https://api.example.com/data'
      ]
    }), /unique/);
  });

  it('requires one to twenty configured patterns', () => {
    assert.throws(() => normalizeFetchToolConfig({ allowedUrlPatterns: [] }), /between 1 and 20/);
    assert.throws(() => normalizeFetchToolConfig({
      allowedUrlPatterns: Array.from(
        { length: 21 },
        (_, index) => `https://api.example.com/${index}`
      )
    }), /between 1 and 20/);
  });

  it('accepts exactly one string URL tool argument', () => {
    assert.deepEqual(normalizeFetchToolInput({ url: 'https://api.example.com/data' }), {
      url: 'https://api.example.com/data'
    });
    for (const value of [
      {},
      { url: 42 },
      { url: 'https://api.example.com/data', method: 'POST' },
      { url: 'https://api.example.com/data', headers: {} }
    ]) {
      assert.throws(() => normalizeFetchToolInput(value), /exactly one string url argument/);
    }
  });
});
