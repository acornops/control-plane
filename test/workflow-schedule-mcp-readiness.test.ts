import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import {
  createWorkflowScheduleForWorkspace,
  listWorkspaceWorkflowSchedules
} from '../src/controllers/workflow-schedules-controller.js';
import { db } from '../src/infra/db.js';
import { runWorkflowScheduleTick } from '../src/services/workflow-scheduler.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

const mutableConfig = config as typeof config & { AUTOMATION_RUNTIME_MODE: 'off' | 'shadow' | 'canary' | 'on' };
let originalRuntimeMode = config.AUTOMATION_RUNTIME_MODE;

beforeEach(async () => {
  originalRuntimeMode = config.AUTOMATION_RUNTIME_MODE;
  mutableConfig.AUTOMATION_RUNTIME_MODE = 'on';
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});

afterEach(() => {
  mutableConfig.AUTOMATION_RUNTIME_MODE = originalRuntimeMode;
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('workflow schedule MCP readiness', () => {
  it('auto-pauses before run creation when exact user MCP readiness fails', async () => {
    installWorkspace('admin');
    const { repo } = await import('../src/store/repository.js');
    const auditEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
    const insertAuditEvent = repo.insertWorkspaceAuditEvent;
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push(event);
      return insertAuditEvent(event);
    };
    await db.query(
      `UPDATE capability_routing_mappings
       SET mcp_tools=$3::jsonb,
           target_ids='["cluster-1"]'::jsonb,
           target_tool_refs='[{"serverId":"builtin-server-1","toolName":"list_resources","alias":"list_resources","operation":"read"}]'::jsonb
       WHERE workspace_id=$1 AND id=$2`,
      [
        'workspace-1',
        'route-target-diagnostics',
        JSON.stringify([{
          serverId: 'server-1',
          toolName: 'records.list',
          alias: 'records.list',
          operation: 'read'
        }])
      ]
    );
    const readinessRequests: Array<Record<string, unknown>> = [];
    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
        readinessRequests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({
          ready: false,
          failures: [{
            server_id: 'server-1',
            tool_name: 'records.list',
            code: 'MCP_PERSONAL_CONNECTION_MISSING',
            action: 'connect_mcp_server'
          }]
        }), { status: 200 });
      }
      if (url === `${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs` && init?.method === 'POST') {
        executionDispatches.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const created = await callController(createWorkflowScheduleForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: 'cluster-triage',
        name: 'MCP readiness schedule',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: true,
        principal: { type: 'user', id: 'user-1' },
        inputDefaults: { targetId: 'cluster-1' },
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    const schedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;

    const result = await runWorkflowScheduleTick({ now: new Date(schedule.nextRunAt) });

    assert.equal(result.dispatched, 0);
    assert.equal(result.autoPaused, 1);
    assert.equal(executionDispatches.length, 0);
    assert.deepEqual(readinessRequests, [{
      workspace_id: 'workspace-1',
      principal: { type: 'user', id: 'user-1' },
      tool_refs: [{ server_id: 'server-1', tool_name: 'records.list' }]
    }]);
    const listed = await callController(
      listWorkspaceWorkflowSchedules,
      createRequest({ workspaceId: 'workspace-1' })
    );
    const paused = (listed.body as {
      items: Array<{ id: string; status: string; lastStatus?: string }>;
    }).items.find((item) => item.id === schedule.id);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.lastStatus, 'auto_paused');
    const audit = auditEvents.find((event) => event.eventType === 'workflow.schedule_auto_paused.v1');
    assert.equal(audit?.metadata?.reason, 'mcp_readiness_failed');
    assert.equal(audit?.metadata?.readinessCode, 'MCP_PERSONAL_CONNECTION_REQUIRED');
  });
});
