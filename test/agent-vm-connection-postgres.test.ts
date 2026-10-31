import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import WebSocket from 'ws';
import { handleAgentHandshake } from '../src/agent/handshake.js';
import { markConnectionOfflineIfUnowned } from '../src/agent/offline-reconciliation.js';
import { getAgentConnection } from '../src/agent/connections.js';
import type { AgentConnection } from '../src/agent/types.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';
import { webhooks } from '../src/services/webhooks.js';
import { resetAutomationDatabaseFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { FakeWebSocket, installRedisStore, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest, agentOwnerKey, setOwner } from './helpers/agent-gateway-fixtures.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const targetId = 'vm-lifecycle';
let owners: Map<string, string>;
let events: Array<Record<string, unknown>>;
function connection(id = 'old'): AgentConnection {
  return { clusterId: targetId, targetType: 'virtual_machine', workspaceId: 'workspace-1', connectionId: id, keyVersion: 1, connectorVersion: 'agentv/0.0.1-experimental.14', ws: new FakeWebSocket() as unknown as WebSocket };
}
function owner(id: string, state?: 'draining') {
  setOwner(owners, targetId, { instanceId: config.CONTROL_PLANE_INSTANCE_ID, workspaceId: 'workspace-1', connectionId: id, updatedAt: new Date().toISOString(), state });
}
async function state() {
  return (await db.query(`SELECT t.status,t.metadata,r.last_connection_id FROM targets t JOIN target_agent_registrations r ON r.target_id=t.id WHERE t.id=$1`, [targetId])).rows[0];
}
async function handshake(ws = new FakeWebSocket(), connectorVersion = 'agentv/0.0.1-experimental.14') {
  await handleAgentHandshake({ ws: ws as unknown as WebSocket, requestId: 'connect', connectorVersion, agentKeyHeader: 'synthetic', params: {
    targetId, targetType: 'virtual_machine', agentType: 'agentv', supportedCapabilities: ['read'], hostFeatures: { osFamily: 'linux', serviceManager: 'systemd' }
  } });
  return ws;
}

describe('VM connection persistence', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures(); setupControlPlaneCoordinationTest();
    owners = new Map(); installRedisStore(owners); events = [];
    mock.method(webhooks, 'emit', (event) => { events.push(event as unknown as Record<string, unknown>); });
    await db.query(`INSERT INTO targets(id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
      VALUES($1,'workspace-1','virtual_machine','VM','online','{"hostname":"kept-host","allowedLogSources":["journald"],"custom":"preserve"}',NOW(),NOW())`, [targetId]);
    await db.query(`INSERT INTO target_agent_registrations(target_id,workspace_id,agent_key_hash,key_version,last_connection_id,last_connector_version)
      VALUES($1,'workspace-1','synthetic',1,'old','agentv/0.0.1-experimental.14')`, [targetId]);
    mock.method(repo.agentv, 'authenticateAgentVCredential', async () => ({ credential: { id: 'credential', targetId, enrollmentId: 'enrollment', keyHash: 'synthetic', generation: 1, state: 'active' as const }, workspaceId: 'workspace-1', provisional: false }));
  });
  afterEach(teardownControlPlaneCoordinationTest);
  after(closeAutomationDatabaseFixtures);

  for (const platform of ['legacy-linux', 'windows']) {
    it(`disconnects ${platform} with VM event identity and unchanged metadata`, async () => {
      if (platform === 'windows') await db.query(`UPDATE targets SET metadata=metadata || '{"osFamily":"windows","serviceManager":"scm","allowedLogSources":["System"]}'::jsonb WHERE id=$1`, [targetId]);
      const before = await state(); owner('old');
      await markConnectionOfflineIfUnowned(targetId, connection());
      assert.deepEqual(await state(), { ...before, status: 'offline', last_connection_id: null });
      assert.deepEqual(events.map((event) => [event.type, event.targetType, event.targetId, event.clusterId]), [
        ['agent.disconnected.v1', 'virtual_machine', targetId, undefined], ['target.status_changed.v1', 'virtual_machine', targetId, undefined]
      ]);
      await markConnectionOfflineIfUnowned(targetId, connection()); assert.equal(events.length, 2);
    });
  }
  it('keeps an absent-owner replacement online when the departed identity is stale', async () => {
    await db.query('UPDATE target_agent_registrations SET last_connection_id=$2 WHERE target_id=$1', [targetId, 'replacement']);
    await markConnectionOfflineIfUnowned(targetId, connection());
    assert.equal((await state()).status, 'online'); assert.equal(events.length, 0);
  });
  it('retains bounded draining ownership while marking the matching VM offline', async () => {
    owner('old', 'draining'); await markConnectionOfflineIfUnowned(targetId, connection());
    assert.equal((await state()).status, 'offline'); assert.equal(JSON.parse(owners.get(agentOwnerKey(targetId))!).state, 'draining');
  });
  it('rejects a superseded claim that completes after a replacement persisted and published', async () => {
    const claimed = deferred(); const release = deferred(); let calls = 0;
    mock.method(redis, 'set', async (...args: unknown[]) => {
      owners.set(String(args[0]), String(args[1]));
      if (++calls === 1) { claimed.resolve(); await release.promise; }
      return 'OK';
    });
    const first = new FakeWebSocket(); const firstPending = handshake(first); await claimed.promise;
    const replacement = await handshake(); const replacementId = getAgentConnection(targetId)!.connectionId;
    release.resolve(); await firstPending;
    assert.equal((await state()).last_connection_id, replacementId);
    assert.equal((await state()).status, 'online');
    assert.equal(getAgentConnection(targetId)!.ws, replacement);
    assert.equal(JSON.parse(owners.get(agentOwnerKey(targetId))!).connectionId, replacementId);
    assert.equal(first.sent.length, 0); assert.equal(first.readyState, WebSocket.CLOSED);
  });
  it('preserves a concurrently committed status when a settings patch omits it', async () => {
    const read = deferred(); const release = deferred(); const query = db.query.bind(db);
    mock.method(db, 'query', async (...args: unknown[]) => {
      const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
      if (String(args[0]).includes('FROM targets WHERE id = $1') && !String(args[0]).includes('UPDATE')) { read.resolve(); await release.promise; }
      return result;
    });
    const pending = repo.updateVirtualMachine(targetId, { hostname: 'new-host' }); await read.promise;
    await query("UPDATE targets SET status='offline' WHERE id=$1", [targetId]); release.resolve(); await pending;
    const current = await state(); assert.equal(current.status, 'offline'); assert.equal(current.metadata.hostname, 'new-host'); assert.equal(current.metadata.custom, 'preserve');
  });
  it('fences delayed post-commit local publication after a newer local handshake', async () => {
    const committed = deferred(); const release = deferred();
    const transition = repo.transitionVirtualMachineConnection.bind(repo); let online = 0;
    mock.method(repo, 'transitionVirtualMachineConnection', async (id, input) => {
      const result = await transition(id, input);
      if (input.status === 'online' && ++online === 1) { committed.resolve(); await release.promise; }
      return result;
    });
    const first = new FakeWebSocket(); const pending = handshake(first); await committed.promise;
    const newer = await handshake(); const newerId = getAgentConnection(targetId)!.connectionId;
    release.resolve(); await pending;
    assert.equal(getAgentConnection(targetId)!.ws, newer); assert.equal((await state()).last_connection_id, newerId);
    assert.equal(first.sent.length, 0); assert.equal(first.readyState, WebSocket.CLOSED);
    assert.equal(events.filter((event) => event.type === 'agent.connected.v1').length, 1);
  });
  it('cleans a socket closed after online persistence without publishing success', async () => {
    const ws = new FakeWebSocket(); const transition = repo.transitionVirtualMachineConnection.bind(repo);
    mock.method(repo, 'transitionVirtualMachineConnection', async (id, input) => {
      const result = await transition(id, input); if (input.status === 'online') ws.close(); return result;
    });
    await handshake(ws);
    assert.equal(getAgentConnection(targetId), undefined); assert.equal(owners.has(agentOwnerKey(targetId)), false);
    assert.equal((await state()).status, 'offline'); assert.equal((await state()).last_connection_id, null);
    assert.equal(events.some((event) => event.type === 'agent.connected.v1'), false);
  });
  it('removes an allocated local connection and refresh interval if acknowledgement fails', async () => {
    const ws = new FakeWebSocket(); let published: AgentConnection | undefined;
    mock.method(ws, 'send', () => { published = getAgentConnection(targetId); throw new Error('socket write failed'); });
    await assert.rejects(handshake(ws), /socket write failed/);
    assert.ok(published); assert.equal(published.ownerRefreshInterval, undefined);
    assert.equal(getAgentConnection(targetId), undefined); assert.equal(owners.has(agentOwnerKey(targetId)), false);
    assert.equal((await state()).status, 'offline');
  });
  it('reconciles the prior persisted identity when a failed claim leaves no usable owner', async () => {
    owner('old');
    mock.method(redis, 'set', async (...args: unknown[]) => { owners.set(String(args[0]), String(args[1])); throw new Error('claim response lost'); });
    await assert.rejects(handshake(new FakeWebSocket(), 'agentv/replacement'), /claim response lost/);
    assert.equal((await state()).status, 'offline'); assert.equal((await state()).last_connection_id, null);
    assert.equal(owners.has(agentOwnerKey(targetId)), false);
    const event = events.find((event) => event.type === 'agent.disconnected.v1')!;
    assert.deepEqual(event.data, { connectionId: 'old', connectorVersion: 'agentv/0.0.1-experimental.14' });
  });
  it('does not clear a persisted replacement when a superseded claim rejects late', async () => {
    const claimed = deferred(); const release = deferred(); let calls = 0;
    mock.method(redis, 'set', async (...args: unknown[]) => {
      owners.set(String(args[0]), String(args[1]));
      if (++calls === 1) { claimed.resolve(); await release.promise; throw new Error('old claim failed'); }
      return 'OK';
    });
    const pending = handshake(); const rejected = assert.rejects(pending, /old claim failed/); await claimed.promise;
    const replacement = await handshake(); const id = getAgentConnection(targetId)!.connectionId;
    release.resolve(); await rejected;
    assert.equal((await state()).last_connection_id, id); assert.equal((await state()).status, 'online');
    assert.equal(getAgentConnection(targetId)!.ws, replacement);
    assert.equal(JSON.parse(owners.get(agentOwnerKey(targetId))!).connectionId, id);
  });
  it('serializes a replacement behind a disconnect that already passed its second owner check', async () => {
    owner('old'); const claimReady = deferred(); const claimRelease = deferred();
    const checked = deferred(); const release = deferred(); let reads = 0;
    mock.method(redis, 'set', async (...args: unknown[]) => {
      claimReady.resolve(); await claimRelease.promise;
      owners.set(String(args[0]), String(args[1])); return 'OK';
    });
    // Complete the existing capability/seen writes before D holds registration.
    const replacement = handshake(); await claimReady.promise;
    mock.method(redis, 'get', async (key: string) => {
      const value = owners.get(key) || null;
      if (++reads === 2) { checked.resolve(); await release.promise; }
      return value;
    });
    const departing = markConnectionOfflineIfUnowned(targetId, connection()); await checked.promise;
    claimRelease.resolve();
    try {
      const deadline = Date.now() + 2000;
      while (!owners.has(agentOwnerKey(targetId)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
      assert.ok(owners.has(agentOwnerKey(targetId)));
    } finally { release.resolve(); }
    await departing; const ws = await replacement;
    const id = getAgentConnection(targetId)!.connectionId;
    assert.equal((await state()).status, 'online'); assert.equal((await state()).last_connection_id, id);
    assert.equal(getAgentConnection(targetId)!.ws, ws);
  });
  it('preserves concurrent VM settings while a disconnect holds the target lock', async () => {
    owner('old'); const checked = deferred(); const release = deferred(); let reads = 0;
    mock.method(redis, 'get', async (key: string) => {
      const value = owners.get(key) || null; if (++reads === 2) { checked.resolve(); await release.promise; } return value;
    });
    const offline = markConnectionOfflineIfUnowned(targetId, connection()); await checked.promise;
    const setting = repo.updateVirtualMachine(targetId, { hostname: 'concurrent-host', allowedLogSources: ['syslog'] });
    release.resolve(); await Promise.all([offline, setting]);
    const row = await state(); assert.equal(row.status, 'offline');
    assert.deepEqual(row.metadata.allowedLogSources, ['syslog']); assert.equal(row.metadata.hostname, 'concurrent-host'); assert.equal(row.metadata.custom, 'preserve');
  });
  it('protects a local replacement during failed-handshake cleanup without distributed routing', async () => {
    config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = false;
    const committed = deferred(); const release = deferred(); const transition = repo.transitionVirtualMachineConnection.bind(repo); let online = 0;
    mock.method(repo, 'transitionVirtualMachineConnection', async (id, input) => {
      const result = await transition(id, input);
      if (input.status === 'online' && ++online === 1) { committed.resolve(); await release.promise; }
      return result;
    });
    const old = handshake(); await committed.promise; const replacement = await handshake(); const id = getAgentConnection(targetId)!.connectionId;
    release.resolve(); await old;
    assert.equal((await state()).status, 'online'); assert.equal((await state()).last_connection_id, id); assert.equal(getAgentConnection(targetId)!.ws, replacement);
  });

  it('protects a newer pending attempt during orphan cleanup without distributed routing', async () => {
    config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = false;
    const firstCommitted = deferred(); const releaseFirst = deferred(); const secondStarted = deferred(); const releaseSecond = deferred();
    const transition = repo.transitionVirtualMachineConnection.bind(repo); let online = 0;
    mock.method(repo, 'transitionVirtualMachineConnection', async (id, input) => {
      if (input.status !== 'online') return transition(id, input);
      const order = ++online;
      if (order === 2) { secondStarted.resolve(); await releaseSecond.promise; }
      const result = await transition(id, input);
      if (order === 1) { firstCommitted.resolve(); await releaseFirst.promise; }
      return result;
    });
    const first = handshake(); await firstCommitted.promise;
    const second = handshake(); await secondStarted.promise;
    releaseFirst.resolve(); await first;
    assert.equal((await state()).status, 'online'); assert.equal(events.some((event) => event.type === 'agent.disconnected.v1'), false);
    releaseSecond.resolve(); const ws = await second; assert.equal(getAgentConnection(targetId)!.ws, ws);
  });
  it('rolls back and cleans up a failed online persistence before acknowledgement', async () => {
    const transition = repo.transitionVirtualMachineConnection.bind(repo);
    mock.method(repo, 'transitionVirtualMachineConnection', async (id, input) => {
      if (input.status === 'online') throw new Error('database unavailable'); return transition(id, input);
    });
    const ws = new FakeWebSocket(); await assert.rejects(handshake(ws), /database unavailable/);
    assert.equal(ws.sent.length, 0); assert.equal(ws.readyState, WebSocket.CLOSED);
    assert.equal(getAgentConnection(targetId), undefined); assert.equal((await state()).status, 'offline');
    assert.equal(owners.has(agentOwnerKey(targetId)), false);
  });
  it('bounds owner reads, releases the database lock and ignores a late observation', async () => {
    const original = config.AGENT_WS_HANDSHAKE_TIMEOUT_MS; config.AGENT_WS_HANDSHAKE_TIMEOUT_MS = 20;
    let resolveRead!: (value: string | null) => void; let reads = 0; let stale: string | null = null;
    mock.method(redis, 'get', async (key: string) => {
      if (++reads === 1) { stale = owners.get(key) || null; return new Promise<string | null>((resolve) => { resolveRead = resolve; }); }
      return owners.get(key) || null;
    });
    const ws = new FakeWebSocket();
    try {
      await assert.rejects(handshake(ws), /ownership observation timed out/);
      assert.equal((await state()).status, 'offline'); assert.equal(ws.sent.length, 0); assert.equal(getAgentConnection(targetId), undefined);
      const client = await db.connect();
      try { await client.query('BEGIN'); await client.query('SELECT id FROM targets WHERE id=$1 FOR UPDATE NOWAIT', [targetId]); }
      finally { await client.query('ROLLBACK'); client.release(); }
      resolveRead(stale); await new Promise((done) => setImmediate(done));
      assert.equal(ws.sent.length, 0); assert.equal(getAgentConnection(targetId), undefined);
    } finally { config.AGENT_WS_HANDSHAKE_TIMEOUT_MS = original; }
  });

});
