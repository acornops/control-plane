import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  rotateTargetAgentKey,
  updateTargetAgentCapabilities,
  updateTargetAgentSeen
} from '../src/store/repository-target-agent-registrations.js';

describe('target agent registration updates', () => {
  afterEach(() => mock.restoreAll());

  it('updates liveness fields without rewriting key material', async () => {
    let sql = '';
    let params: unknown[] = [];
    mock.method(db, 'query', async (statement: string, values?: unknown[]) => {
      sql = statement;
      params = values ?? [];
      return { rowCount: 1, rows: [] };
    });

    await updateTargetAgentSeen('cluster-1', { lastHeartbeatAt: '2026-07-11T00:00:00.000Z' });

    assert.doesNotMatch(sql, /agent_key_hash|key_version/);
    assert.deepEqual(params, ['cluster-1', null, '2026-07-11T00:00:00.000Z', null, null]);
  });

  it('updates capabilities without rewriting key material', async () => {
    let sql = '';
    mock.method(db, 'query', async (statement: string) => {
      sql = statement;
      return { rowCount: 1, rows: [] };
    });

    await updateTargetAgentCapabilities('cluster-1', ['read']);

    assert.match(sql, /SET capabilities/);
    assert.doesNotMatch(sql, /agent_key_hash|key_version/);
  });

  it('rotates a key only when the expected version is still current', async () => {
    let params: unknown[] = [];
    mock.method(db, 'query', async (_statement: string, values?: unknown[]) => {
      params = values ?? [];
      return { rowCount: 1, rows: [{ key_version: 2 }] };
    });

    assert.equal(await rotateTargetAgentKey('cluster-1', 1, 'new-hash'), 2);
    assert.deepEqual(params, ['cluster-1', 1, 'new-hash']);
  });

  it('reports a concurrent rotation conflict', async () => {
    mock.method(db, 'query', async () => ({ rowCount: 0, rows: [] }));

    assert.equal(await rotateTargetAgentKey('cluster-1', 1, 'new-hash'), null);
  });
});
