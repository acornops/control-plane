import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requireActor } from '../src/auth/middleware.js';
import { config } from '../src/config.js';

const DEV_EXTERNAL_INTEGRATION_CLIENT = config.EXTERNAL_INTEGRATION_CLIENTS[0];
const DEV_EXTERNAL_INTEGRATION_TOKEN = 'dev_external_integration_client_token';

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

describe("requireActor(['externalIntegrationClient']) middleware", () => {
  it('requires a registered external integration client token', async () => {
    const requireClientActor = requireActor(['externalIntegrationClient']);
    const deniedRes = createResponse();
    let nextCalled = false;
    await requireClientActor(
      { header: () => 'Bearer wrong-token' } as never,
      deniedRes as never,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(deniedRes.statusCode, 401);
    assert.equal(nextCalled, false);

    const allowedReq = {
      header: () => `Bearer ${DEV_EXTERNAL_INTEGRATION_TOKEN}`
    } as { externalIntegrationClient?: unknown; header(name: string): string };
    const allowedRes = createResponse();
    await requireClientActor(
      allowedReq as never,
      allowedRes as never,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);
    assert.deepEqual(allowedReq.externalIntegrationClient, DEV_EXTERNAL_INTEGRATION_CLIENT);
  });
});
