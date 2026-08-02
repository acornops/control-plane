import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_WORKSPACE_ID } from '../src/constants/dev-defaults.js';
import { db } from '../src/infra/db.js';
import { ensureDevelopmentTargetSeed } from '../src/store/repository-development-seed.js';
import { verifySecret } from '../src/utils/crypto.js';

afterEach(() => {
  mock.restoreAll();
});

describe('development target seed', () => {
  it('routes the development workspace through universal starter provisioning before target fixtures', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const transactionQueries: Array<{ sql: string; params: unknown[] }> = [];
    const agentRows = new Map<string, Record<string, unknown>>();
    const workflowRows = new Map<string, Record<string, unknown>>();
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('INSERT INTO users')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'owner-user',
            email: 'dev@acornops.local',
            display_name: 'Dev User',
            email_verified_at: new Date('2026-01-01T00:00:00.000Z'),
            email_verification_required: false,
            created_at: new Date('2026-01-01T00:00:00.000Z')
          }]
        };
      }
      if (sql.includes('SELECT * FROM agent_definitions')) {
        const row = params?.[1]
          ? agentRows.get(String(params[1]))
          : [...agentRows.values()];
        return Array.isArray(row)
          ? { rowCount: row.length, rows: row }
          : { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('UPDATE agent_definitions SET readiness_status')) {
        const row = agentRows.get(String(params?.[1]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('SELECT * FROM workflow_definitions')) {
        const row = workflowRows.get(String(params?.[1]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('UPDATE workflow_definitions SET readiness_status')) {
        const row = workflowRows.get(String(params?.[1]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      return { rowCount: 1, rows: [] };
    });
    mock.method(db, 'connect', async () => ({
      query: async (sql: string, params?: unknown[]) => {
        transactionQueries.push({ sql, params: params ?? [] });
        if (sql.includes('SELECT created_by FROM workspaces')) {
          return { rowCount: 1, rows: [{ created_by: 'owner-user' }] };
        }
        if (sql.includes('INSERT INTO agent_definitions')) {
          const values = params || [];
          const row = {
            workspace_id: values[0], id: values[1], name: values[2], avatar_emoji: values[21], description: values[3],
            instructions: values[4], status: 'active', review_state: values[5], provider_type: values[6],
            owner_user_id: values[7], created_by: values[8], mcp_servers: JSON.parse(String(values[9])),
            mcp_tools: JSON.parse(String(values[10])), mcp_installations: JSON.parse(String(values[11])),
            tools: JSON.parse(String(values[12])), native_tool_configs: JSON.parse(String(values[13])),
            skills: JSON.parse(String(values[14])), skill_installations: JSON.parse(String(values[15])),
            context_grants: JSON.parse(String(values[16])),
            approval_policy: values[17], trust_policy: values[18], permission_mode: values[19],
            semantic_capability_ids: JSON.parse(String(values[20])),
            readiness_status: 'needs_setup', readiness_reasons: JSON.parse(String(values[22])),
            created_at: new Date(), updated_at: new Date()
          };
          agentRows.set(String(values[1]), row);
          return { rowCount: 1, rows: [row] };
        }
        if (sql.includes('FROM agent_definitions agent')) {
          const row = agentRows.get(String(params?.[1]));
          return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        }
        if (sql.includes('INSERT INTO capability_routing_mappings') && sql.includes('RETURNING *')) {
          const values = params || [];
          return { rowCount: 1, rows: [{
            workspace_id: values[0], id: values[1], capability_id: values[2],
            agent_id: values[3], status: values[4], review_state: values[5],
            priority: values[6], mcp_tools: JSON.parse(String(values[7])),
            native_tool_ids: JSON.parse(String(values[8])), skill_ids: JSON.parse(String(values[9])),
            context_grants: JSON.parse(String(values[10])), created_by: values[11],
            reviewed_by: values[12], created_at: new Date(), updated_at: new Date()
          }] };
        }
        if (sql.includes('INSERT INTO workflow_definitions')) {
          const values = params || [];
          const row = {
            workspace_id: values[0], id: values[1], name: values[2],
            description: values[3], status: values[4], prompt: values[5],
            agent_ids: JSON.parse(String(values[6])),
            tags: JSON.parse(String(values[7])),
            created_by: values[8], readiness_status: values[9],
            readiness_reasons: JSON.parse(String(values[10])),
            created_at: new Date(), updated_at: new Date()
          };
          workflowRows.set(String(values[1]), row);
          return { rowCount: 1, rows: [row] };
        }
        if (sql.includes('INSERT INTO workspaces')) {
          return { rowCount: 1, rows: [{
            id: DEVELOPMENT_WORKSPACE_ID,
            name: 'Development Workspace',
            created_by: 'owner-user',
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            plan_key: null
          }] };
        }
        if (sql.includes('SELECT * FROM automation_template_installations')) {
          return { rowCount: 1, rows: [{
            workspace_id: DEVELOPMENT_WORKSPACE_ID,
            template_id: 'acornops-starter',
            state: 'pending',
            installed_by: 'owner-user',
            record_ids: {},
            installed_at: new Date('2026-01-01T00:00:00.000Z')
          }] };
        }
        if (sql.includes("SET state='complete'")) {
          return { rowCount: 1, rows: [{
            workspace_id: DEVELOPMENT_WORKSPACE_ID,
            template_id: 'acornops-starter',
            state: 'complete',
            installed_by: 'owner-user',
            record_ids: params?.[2] || {},
            installed_at: new Date('2026-01-01T00:00:00.000Z')
          }] };
        }
        if (sql.includes('INSERT INTO workspace_audit_events')) {
          return { rowCount: 1, rows: [{
            id: 'audit-1', workspace_id: DEVELOPMENT_WORKSPACE_ID, category: 'workspace',
            event_type: 'workspace.created.v1', operation: 'write', actor_type: 'user',
            actor_user_id: 'owner-user', actor_token_id: null, actor_email: null, actor_display_name: null,
            object_type: 'workspace', object_id: DEVELOPMENT_WORKSPACE_ID, object_name: 'Development Workspace',
            summary: 'Workspace created', metadata: {}, occurred_at: new Date('2026-01-01T00:00:00.000Z')
          }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined
    }) as never);

    await ensureDevelopmentTargetSeed('ak_local_dev_shared_key', 'ak_local_vm_dev_shared_key');

    assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO users')).length, 1);
    assert.equal(transactionQueries.filter(({ sql }) => sql.includes('INSERT INTO workspaces')).length, 1);
    assert.equal(transactionQueries.filter(({ sql }) => sql.includes('INSERT INTO workspace_memberships')).length, 1);
    assert.equal(transactionQueries.filter(({ sql }) => sql.includes('INSERT INTO workspace_initial_defaults')).length, 1);
    assert.equal(transactionQueries.filter(({ sql }) => sql.includes('INSERT INTO workspace_initial_default_skill_files')).length, 1);
    assert.equal(transactionQueries.filter(({ sql }) => sql.includes('INSERT INTO agent_definitions')).length, 2);
    const nativeToolMappings = transactionQueries.filter(({ sql }) =>
      sql.includes('INSERT INTO capability_routing_mappings') && sql.includes('native_tool_ids'));
    assert.equal(nativeToolMappings.length, 2);
    assert(nativeToolMappings.every(({ params }) => String(params[1]).startsWith('native:')));
    assert.equal(transactionQueries.filter(({ sql }) => sql.includes('INSERT INTO workflow_definitions')).length, 2);
    assert.deepEqual(
      [...agentRows.values()].map((row) => row.name).sort(),
      ['Kubernetes Agent', 'Virtual Machine Agent']
    );
    assert.deepEqual(
      [...workflowRows.values()].map((row) => (row.agent_ids as string[]).length).sort(),
      [1, 1]
    );
    const kubernetesWorkflow = [...workflowRows.values()].find((row) => row.name === 'Kubernetes health check');
    assert.match(String(kubernetesWorkflow?.prompt), /available Kubernetes environments.*MCP tools/);
    assert.equal(
      kubernetesWorkflow?.description,
      'Inspect available Kubernetes environments for workload failures, warning events, resource pressure, and relevant logs.'
    );
    const virtualMachineWorkflow = [...workflowRows.values()].find((row) => row.name === 'Virtual machine health check');
    assert.match(String(virtualMachineWorkflow?.prompt), /filesystem pressure.*degraded systemd services/);
    assert.equal(transactionQueries.some(({ sql }) => sql.includes("SET state='complete'")), true);
    assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO targets')).length, 2);
    assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO kubernetes_target_settings')).length, 1);
    assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO target_agent_registrations')).length, 2);
    assert.equal(queries.some(({ sql }) => sql.includes('workspace_invitations')), false);
    assert.equal(queries.some(({ sql }) => /mcp_server|provider_credential|skills/i.test(sql)), false);
    assert.equal(
      [...queries, ...transactionQueries]
        .filter(({ sql }) => /INSERT INTO (users|workspaces|workspace_memberships|targets|kubernetes_target_settings|target_agent_registrations)/.test(sql))
        .every(({ sql }) => sql.includes('ON CONFLICT')),
      true
    );

    const targetQueries = queries.filter(({ sql }) => sql.includes('INSERT INTO targets'));
    const clusterQuery = targetQueries.find(({ params }) => params[0] === DEVELOPMENT_CLUSTER_ID);
    assert.deepEqual(clusterQuery?.params.slice(0, 3), [
      DEVELOPMENT_CLUSTER_ID,
      DEVELOPMENT_WORKSPACE_ID,
      'Development Cluster'
    ]);

    const vmQuery = targetQueries.find(({ params }) => params[0] === DEVELOPMENT_VM_ID);
    assert.deepEqual(vmQuery?.params.slice(0, 4), [
      DEVELOPMENT_VM_ID,
      DEVELOPMENT_WORKSPACE_ID,
      'virtual_machine',
      'Development Linux VM'
    ]);
    assert.deepEqual(JSON.parse(String(vmQuery?.params[4])), {
      hostname: 'acornops-dev-vm',
      osFamily: 'linux',
      serviceManager: 'systemd',
      environment: 'local',
      capabilities: ['read', 'logs', 'mcp', 'chat', 'systemd', 'linux']
    });

    const registrationQueries = queries.filter(({ sql }) => sql.includes('INSERT INTO target_agent_registrations'));
    const clusterRegistration = registrationQueries.find(({ params }) => params[0] === DEVELOPMENT_CLUSTER_ID);
    assert.equal(clusterRegistration?.params[1], DEVELOPMENT_WORKSPACE_ID);
    assert.equal(verifySecret('ak_local_dev_shared_key', String(clusterRegistration?.params[2])), true);
    const vmRegistration = registrationQueries.find(({ params }) => params[0] === DEVELOPMENT_VM_ID);
    assert.equal(vmRegistration?.params[1], DEVELOPMENT_WORKSPACE_ID);
    assert.equal(verifySecret('ak_local_vm_dev_shared_key', String(vmRegistration?.params[2])), true);
  });
});
