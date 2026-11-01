import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import type WebSocket from 'ws';
import { markConnectionOfflineIfUnowned } from '../src/agent/offline-reconciliation.js';
import { publishVirtualMachineConnection } from '../src/agent/vm-connection-lifecycle.js';
import type { AgentConnection } from '../src/agent/types.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { getAgentOwner } from '../src/services/control-plane-coordination/agent-owner.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import { vmConnections } from '../src/store/repository-vm-connections.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { FakeWebSocket, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function reached(signal: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([signal, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Status race barrier was not reached')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

// No fake Redis map or database: barriers delay delivery/publication only.
// These are current-behavior characterizations, not proof of a repair protocol.
describe('VM status boundaries with real PostgreSQL and Redis', () => {
  let targetId: string;
  let key: string;
  let events: unknown[];
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    setupControlPlaneCoordinationTest();
    targetId = `status-race-${randomUUID()}`;
    key = `cp:agent:owner:${targetId}`;
    events = [];
    mock.method(webhooks, 'emit', (event) => { events.push(event); });
  });
  afterEach(async () => {
    teardownControlPlaneCoordinationTest();
    await redis.del(key);
  });
  after(async () => { await redis.quit(); await closeAutomationDatabaseFixtures(); });

  async function seed(platform: 'legacy-linux' | 'windows') {
    const metadata = { hostname: 'kept-host', custom: 'preserve', permissionModeOverride: 'read_only',
      allowedLogSources: platform === 'windows' ? ['System'] : ['journald'],
      ...(platform === 'windows' ? { osFamily: 'windows', serviceManager: 'scm' } : {}) };
    await db.query(`INSERT INTO targets(id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
      VALUES($1,'workspace-1','virtual_machine','VM','online',$2::jsonb,NOW(),NOW())`, [targetId, JSON.stringify(metadata)]);
    await db.query(`INSERT INTO target_agent_registrations(target_id,workspace_id,agent_key_hash,key_version,last_connection_id,last_connector_version)
      VALUES($1,'workspace-1','synthetic-preserved-key',1,'A','agentv/old')`, [targetId]);
  }
  function connection(id: string): AgentConnection {
    return { clusterId: targetId, targetType: 'virtual_machine', workspaceId: 'workspace-1', connectionId: id,
      keyVersion: 1, connectorVersion: `agentv/${id}`, ws: new FakeWebSocket() as unknown as WebSocket };
  }
  async function state() {
    return (await db.query(`SELECT t.status,t.metadata,t.updated_at,r.last_connection_id,r.last_connector_version,
      r.last_seen_at,r.agent_key_hash,r.key_version FROM targets t JOIN target_agent_registrations r ON r.target_id=t.id WHERE t.id=$1`, [targetId])).rows[0];
  }

  for (const platform of ['legacy-linux', 'windows'] as const) {
    it(`${platform}: delayed missing reply permits A offline before Redis-claimed B publishes`, { timeout: 15000 }, async () => {
      await seed(platform);
      const original = await state();
      const missing = barrier(); const deliver = barrier(); const claimed = barrier(); const publish = barrier();
      const get = redis.get.bind(redis); const transition = vmConnections.transition.bind(vmConnections);
      let reads = 0; let published = false;
      mock.method(redis, 'get', async (name: string) => {
        const value = await get(name);
        // Ordinary disconnect reads once before CAS deletion, then inside SQL locks.
        if (name === key && ++reads === 2) {
          assert.equal(value, null); missing.release(); await deliver.promise;
        }
        return value;
      });
      mock.method(vmConnections, 'transition', async (id, input) => {
        if (id === targetId && input.status === 'online') { claimed.release(); await publish.promise; }
        return transition(id, input);
      });
      const departing = markConnectionOfflineIfUnowned(targetId, connection('A'));
      void departing.catch(() => undefined);
      let replacement: Promise<void> | undefined;
      try {
        await reached(missing.promise);
        replacement = publishVirtualMachineConnection({ connection: connection('B'), mayConnect: () => true,
          publish: () => { published = true; } });
        void replacement.catch(() => undefined);
        await reached(claimed.promise);
        assert.equal((await getAgentOwner(targetId))?.connectionId, 'B');
        assert.equal((await state()).last_connection_id, 'A');
        assert.equal(published, false);
        deliver.release(); await departing;
        const intermediate = await state();
        assert.equal(intermediate.status, 'offline');
        assert.equal(intermediate.last_connection_id, null);
        assert.deepEqual(intermediate.metadata, original.metadata);
        assert.equal((await getAgentOwner(targetId))?.connectionId, 'B');
        assert.equal(published, false);
        publish.release(); await replacement;
        const final = await state();
        assert.equal(published, true);
        assert.equal(final.status, 'online'); assert.equal(final.last_connection_id, 'B');
        assert.equal(final.last_connector_version, 'agentv/B');
        assert.equal(final.agent_key_hash, original.agent_key_hash);
        assert.deepEqual(final.metadata, original.metadata);
      } finally {
        deliver.release(); publish.release();
        await Promise.allSettled([departing, ...(replacement ? [replacement] : [])]);
      }
    });

    for (const status of ['online', 'degraded'] as const) for (const ownerPresent of [true, false]) {
      it(`${platform}: old cleanup preserves committed B (${status}, owner present=${ownerPresent})`, { timeout: 15000 }, async () => {
        await seed(platform);
        const observed = barrier(); const deliver = barrier(); const get = redis.get.bind(redis);
        let first = true;
        mock.method(redis, 'get', async (name: string) => {
          const value = await get(name);
          if (name === key && first) { first = false; observed.release(); await deliver.promise; }
          return value;
        });
        const departing = markConnectionOfflineIfUnowned(targetId, connection('A'));
        void departing.catch(() => undefined);
        try {
          await reached(observed.promise);
          let published = false;
          await publishVirtualMachineConnection({ connection: connection('B'), mayConnect: () => true,
            publish: () => { published = true; } });
          assert.equal(published, true);
          await repo.updateVirtualMachine(targetId, { status, hostname: 'edited-host', permissionModeOverride: 'read_only' });
          if (!ownerPresent) await redis.del(key);
          const committed = await state();
          assert.equal(committed.last_connection_id, 'B');
          assert.equal(committed.metadata.hostname, 'edited-host');
          assert.equal(committed.metadata.custom, 'preserve');
          deliver.release(); await departing;
          assert.deepEqual(await state(), committed);
          assert.equal((await getAgentOwner(targetId))?.connectionId, ownerPresent ? 'B' : undefined);
          assert.deepEqual(events, []);
        } finally { deliver.release(); await Promise.allSettled([departing]); }
      });
    }
  }
});
