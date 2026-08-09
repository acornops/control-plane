import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  exchangeAgentVEnrollment,
  getAgentVInstallationStatus
} from '../src/controllers/agentv-installation-controller.js';
import { repo } from '../src/store/repository.js';
import { redis } from '../src/infra/redis.js';

afterEach(() => {
  mock.restoreAll();
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }
  };
}

const enrollment = {
  id: '11111111-1111-4111-8111-111111111111',
  targetId: 'vm-1', workspaceId: 'workspace-1', purpose: 'initial' as const,
  accessPolicy: { accessMode: 'read_write' as const, restartServices: ['nginx.service'] },
  tokenHash: 'scrypt$redacted', transactionSecretHash: 'scrypt$redacted', status: 'exchanged' as const,
  createdBy: 'user-1', expiresAt: '2026-08-09T00:15:00.000Z', transactionExpiresAt: '2026-08-09T01:00:00.000Z'
};
const credential = {
  id: 'credential-1', targetId: 'vm-1', enrollmentId: enrollment.id,
  keyHash: 'scrypt$redacted', generation: 1, state: 'pending' as const
};

describe('AgentV bootstrap transaction API', () => {
  it('rejects malformed target and transaction identifiers before repository access', async () => {
    mock.method(repo.agentv, 'exchangeAgentVEnrollment', async () => {
      assert.fail('malformed enrollment input must not reach the repository');
    });
    mock.method(repo.agentv, 'getAgentVInstallationStatus', async () => {
      assert.fail('malformed transaction input must not reach the repository');
    });

    const exchange = response();
    const token = `aev_${enrollment.id}_${'a'.repeat(43)}`;
    const malformedRequest = {
      body: { targetId: '../vm-1', enrollmentToken: token, purpose: 'initial' },
      ip: '127.0.0.1', rawBody: JSON.stringify({ enrollmentToken: token })
    };
    await exchangeAgentVEnrollment(malformedRequest as never, exchange as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(exchange.statusCode, 400);
    assert.equal(malformedRequest.body.enrollmentToken, '[REDACTED]');
    assert.equal('rawBody' in malformedRequest, false);

    const status = response();
    await getAgentVInstallationStatus({
      params: { transactionId: '../transaction' },
      header: (name: string) => name === 'x-agentv-transaction-secret' ? 'protected' : undefined
    } as never, status as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(status.statusCode, 400);
  });

  it('returns secrets only from a no-store exchange response and rejects a replay generically', async () => {
    mock.method(redis, 'incr', async () => 1);
    mock.method(redis, 'expire', async () => 1);
    const token = `aev_${enrollment.id}_${'a'.repeat(43)}`;
    let accepted = true;
    mock.method(repo.agentv, 'exchangeAgentVEnrollment', async () => accepted ? ({
      enrollment, agentKey: 'ak_vm-1_durable', transactionSecret: 'avt_transaction-secret'
    }) : null);
    const first = response();
    await exchangeAgentVEnrollment({ body: { targetId: 'vm-1', enrollmentToken: token, purpose: 'initial' }, ip: '127.0.0.1' } as never, first as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['Cache-Control'], 'no-store');
    assert.deepEqual(first.body, {
      transactionId: enrollment.id,
      transactionSecret: 'avt_transaction-secret',
      agentKey: 'ak_vm-1_durable',
      purpose: 'initial',
      accessPolicy: { accessMode: 'read_write', restartServices: ['nginx.service'] }
    });

    accepted = false;
    const replay = response();
    await exchangeAgentVEnrollment({ body: { targetId: 'vm-1', enrollmentToken: token, purpose: 'initial' }, ip: '127.0.0.1' } as never, replay as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(replay.statusCode, 401);
    assert.equal(JSON.stringify(replay.body).includes(token), false);
  });

  it('reports whether the committed credential has reconnected normally', async () => {
    mock.method(redis, 'incr', async () => 1);
    mock.method(redis, 'expire', async () => 1);
    mock.method(repo.agentv, 'getAgentVInstallationStatus', async () => ({
      enrollment: { ...enrollment, status: 'completed' as const },
      credential: { ...credential, state: 'active' as const },
      activeConnected: true
    }));
    const res = response();
    await getAgentVInstallationStatus({
      params: { transactionId: enrollment.id },
      header: (name: string) => name === 'x-agentv-transaction-secret' ? 'protected' : undefined
    } as never, res as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal((res.body as { activeConnected: boolean }).activeConnected, true);
  });
});
