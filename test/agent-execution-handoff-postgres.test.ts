import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { AgentGateway } from '../src/agent/ws-server.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { withAgentExecution } from '../src/agent/execution-authority.js';
import { acquireRunCapacity, reserveRunCapacity } from '../src/store/repository-run-capacity.js';
import { withTransaction } from '../src/store/repository-transaction.js';
import { coordinatedRoot } from './helpers/workflow-delegation-postgres-fixtures.js';
import { resetAutomationDatabaseFixtures, installAutomationTemplateFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { installRedisStore, setOwner, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);
after(closeAutomationDatabaseFixtures);
for (const scenario of ['interactive cancellation', 'Workflow cancellation intent', 'expired capacity'] as const) {
  test(`handoff never dispatches after ${scenario}`, async () => {
    await resetAutomationDatabaseFixtures();
    const originalCapacity = config.WORKSPACE_CAPACITY_ENABLED;
    config.WORKSPACE_CAPACITY_ENABLED = scenario === 'expired capacity';
    const owners = new Map<string, string>();
    installRedisStore(owners);
    setOwner(owners, 'cluster-1', { instanceId: 'old', connectionId: 'old', workspaceId: 'workspace-1', updatedAt: 'now', state: 'draining' });
    let runId = 'cancel-handoff';
    let generation = 0;
    if (scenario === 'Workflow cancellation intent') {
      await installAutomationTemplateFixtures();
      runId = (await coordinatedRoot()).parent.id;
    } else {
      await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
        VALUES('handoff-session','workspace-1','cluster-1','user-1','Handoff','open',NOW(),NOW())`);
      await db.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
        VALUES($1,'workspace-1','cluster-1','handoff-session',$1,'running',NOW())`, [runId]);
      if (config.WORKSPACE_CAPACITY_ENABLED) {
        await withTransaction((client) => reserveRunCapacity(client, { workspaceId: 'workspace-1', runId, pool: 'chat' }));
        generation = (await acquireRunCapacity(runId, 'engine')).generation!;
      }
    }
    let published = 0;
    mock.method(redis, 'publish', async () => { published++; return 0; });
    const gateway = new AgentGateway();
    try {
      const command = withAgentExecution({ runId, workspaceId: 'workspace-1', ownerId: 'engine', generation }, () =>
        gateway.sendJsonRpc('cluster-1', 'tools/call', { name: 'restart' }, 'stable-cancelled-write'));
      const rejected = assert.rejects(command, (error: unknown) => {
        const value = error as { data?: { code?: string; outcome?: string } };
        assert.equal(value.data?.code, scenario === 'expired capacity' ? 'EXECUTION_AUTHORITY_LOST' : 'RUN_NOT_ACTIVE');
        assert.equal(value.data?.outcome, 'not_started');
        return true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (scenario === 'Workflow cancellation intent') await db.query('UPDATE workflow_runs SET cancellation_requested_at=NOW() WHERE id=$1', [runId]);
      else if (scenario === 'expired capacity') await db.query("UPDATE workspace_run_reservations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1", [runId]);
      else await db.query("UPDATE runs SET status='cancelled' WHERE id=$1", [runId]);
      setOwner(owners, 'cluster-1', { instanceId: 'replacement', connectionId: 'new', workspaceId: 'workspace-1', updatedAt: 'now' });
      await rejected;
      assert.equal(published, 0);
    } finally { config.WORKSPACE_CAPACITY_ENABLED = originalCapacity; }
  });
}
