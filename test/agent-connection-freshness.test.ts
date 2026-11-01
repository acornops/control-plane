import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTarget } from '../src/store/repository-mappers.js';

const observedAt = '2026-11-02T00:02:00.000Z';
const target = {
  id: 'target', workspace_id: 'workspace', target_type: 'virtual_machine' as const,
  name: 'VM', status: 'online' as const, metadata: { preserved: true },
  created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z'
};

for (const [name, status, connectionId, heartbeat, state] of [
  ['recent heartbeat', 'online', 'current', '2026-11-02T00:01:30.000Z', 'connected'],
  ['last millisecond of grace', 'online', 'current', '2026-11-02T00:00:00.001Z', 'connected'],
  ['exact expiry', 'online', 'current', '2026-11-02T00:00:00.000Z', 'disconnected'],
  ['expired heartbeat', 'online', 'current', '2026-11-01T23:59:59.999Z', 'disconnected'],
  ['known disconnect wins', 'offline', 'current', '2026-11-02T00:01:30.000Z', 'disconnected'],
  ['unpublished initial target', 'unknown', 'current', '2026-11-02T00:01:30.000Z', 'unknown'],
  ['reachable degraded target', 'degraded', 'current', '2026-11-02T00:01:30.000Z', 'connected'],
  ['expired degraded target', 'degraded', 'current', '2026-11-01T23:59:59.999Z', 'disconnected'],
  ['missing heartbeat', 'online', 'current', null, 'unknown'],
  ['invalid heartbeat', 'online', 'current', 'invalid', 'unknown'],
  ['future heartbeat', 'online', 'current', '2026-11-02T00:02:00.001Z', 'unknown'],
  ['no published identity', 'online', null, '2026-11-02T00:01:30.000Z', 'unknown']
] as const) {
  test(`public connection observation: ${name}`, () => {
    const result = mapTarget({ ...target, status, connection_id: connectionId,
      connection_heartbeat_at: heartbeat, connection_observed_at: observedAt });
    assert.equal(result.connection?.state, state);
    assert.equal(result.status, status, 'observation cannot overwrite persistent lifecycle/health');
    assert.deepEqual(result.metadata, { preserved: true });
    assert.equal(result.updatedAt, target.updated_at);
  });
}

test('public observation contains only bounded timestamps and state', () => {
  const result = mapTarget({ ...target, connection_id: 'private-connection-id',
    connection_heartbeat_at: new Date('2026-11-02T00:01:30.000Z'), connection_observed_at: observedAt });
  assert.deepEqual(result.connection, {
    state: 'connected', lastHeartbeatAt: '2026-11-02T00:01:30.000Z',
    observedAt, expiresAt: '2026-11-02T00:03:30.000Z', hasConnectionEvidence: true
  });
});

test('legacy rows without a read observation do not invent a clock or connection state', () => {
  assert.equal(Object.hasOwn(mapTarget(target), 'connection'), false);
});

test('rejected heartbeat evidence remains distinct from a never-connected registration', () => {
  for (const heartbeat of ['invalid', '2099-01-01T00:00:00Z']) {
    const connection = mapTarget({ ...target, status: 'unknown', connection_id: 'known-identity',
      connection_heartbeat_at: heartbeat, connection_observed_at: observedAt }).connection;
    assert.equal(connection?.state, 'unknown');
    assert.equal(connection?.hasConnectionEvidence, true);
  }
  const absent = mapTarget({ ...target, status: 'unknown', connection_id: null,
    connection_heartbeat_at: null, connection_observed_at: observedAt }).connection;
  assert.equal(absent?.hasConnectionEvidence, false);
});
