import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import WebSocket from 'ws';
import { handleAgentHandshake } from '../src/agent/handshake.js';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { hashSecret } from '../src/utils/crypto.js';
import { resetAutomationDatabaseFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { FakeWebSocket, installRedisStore, setOwner, mutableConfig,
  setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

describe('failed Kubernetes heartbeat publication', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    setupControlPlaneCoordinationTest();
    await db.query(`INSERT INTO target_agent_registrations(target_id,workspace_id,agent_key_hash,key_version,last_connection_id,last_heartbeat_at)
      VALUES('cluster-1','workspace-1',$1,1,'previous',NOW()-INTERVAL '5 minutes')`, [hashSecret('synthetic-heartbeat-key')]);
  });
  afterEach(teardownControlPlaneCoordinationTest);
  after(closeAutomationDatabaseFixtures);

  for (const replacement of [false, true]) test(`closed final-write attempt clears only its own evidence; replacement=${replacement}`, async () => {
    const owners = new Map<string, string>();
    installRedisStore(owners);
    const ws = new FakeWebSocket();
    let attemptId: string | undefined;
    const update = repo.updateTargetAgentSeen.bind(repo);
    mock.method(repo, 'updateTargetAgentSeen', async (id, data) => {
      await update(id, data);
      if (!data.lastConnectionId) return;
      attemptId = data.lastConnectionId;
      if (replacement) {
        await db.query("UPDATE target_agent_registrations SET last_connection_id='replacement',last_heartbeat_at=NOW() WHERE target_id=$1", [id]);
        setOwner(owners, id, { instanceId: mutableConfig.CONTROL_PLANE_INSTANCE_ID, connectionId: 'replacement', workspaceId: 'workspace-1', updatedAt: new Date().toISOString() });
      }
      ws.close();
    });
    await handleAgentHandshake({ ws: ws as unknown as WebSocket, requestId: 'connect',
      agentKeyHeader: 'synthetic-heartbeat-key', connectorVersion: 'agentk/test', params: {
        targetId: 'cluster-1', targetType: 'kubernetes', agentType: 'agentk'
      } });
    const target = (await repo.getTarget('workspace-1', 'cluster-1'))!;
    const registration = (await repo.getTargetAgentRegistration('cluster-1'))!;
    assert.equal(ws.sent.length, 0);
    assert.equal(target.connection?.state, replacement ? 'connected' : 'unknown');
    assert.equal(registration.lastConnectionId, replacement ? 'replacement' : attemptId);
    assert.equal(Boolean(registration.lastHeartbeatAt), replacement);
    assert.equal(registration.keyVersion, 1);
  });
});
