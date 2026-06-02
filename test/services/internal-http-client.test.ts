import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../../src/config.js';
import { internalFetch } from '../../src/services/internal-http-client.js';

const mutableConfig = config as typeof config & {
  INTERNAL_TRANSPORT_TLS_ENABLED: boolean;
};

const originalInternalTransportTlsEnabled = config.INTERNAL_TRANSPORT_TLS_ENABLED;

afterEach(() => {
  mutableConfig.INTERNAL_TRANSPORT_TLS_ENABLED = originalInternalTransportTlsEnabled;
});

describe('internalFetch', () => {
  it('honors an already-aborted signal before opening an internal TLS request', async () => {
    mutableConfig.INTERNAL_TRANSPORT_TLS_ENABLED = true;
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      internalFetch('https://execution-engine.acornops.svc:8080/health', { signal: controller.signal }),
      /Internal request aborted/
    );
  });
});
