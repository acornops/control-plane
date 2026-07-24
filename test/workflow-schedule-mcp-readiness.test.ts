import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import {
  createWorkflowScheduleForWorkspace,
  listWorkspaceWorkflowSchedules,
  previewWorkflowSchedule,
  updateWorkflowSchedule
} from '../src/controllers/workflow-schedules-controller.js';
import { db } from '../src/infra/db.js';
import { pauseSchedulesForAgentIndividualCredentials } from '../src/services/agent-mcp-schedule-impact.js';
import { pauseSchedulesForTargetIndividualCredentials } from '../src/services/target-mcp-schedule-impact.js';
import { runWorkflowScheduleTick } from '../src/services/workflow-scheduler.js';
import {
  callController,
  createReadyMcpReadinessResponse,
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

async function installExactMcpRequirement(): Promise<void> {
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
}

function scheduleInput(enabled = true): Record<string, unknown> {
  return {
    workflowId: 'cluster-triage',
    name: 'MCP readiness schedule',
    cron: '* * * * *',
    timezone: 'UTC',
    enabled,
    principal: { type: 'user', id: 'user-1' },
    inputs: { target: 'cluster-1' },
    approvedContextGrants: ['workspace_metadata', 'target_inventory']
  };
}

function missingConnectionResponse(): Response {
  return new Response(JSON.stringify({
    ready: false,
    failures: [{
      server_id: 'server-1',
      tool_name: 'records.list',
      code: 'MCP_CONNECTION_MISSING',
      action: 'connect_mcp_server'
    }]
  }), { status: 200 });
}

describe('workflow schedule MCP readiness', () => {
  it('shows missing user MCP connections in preview and rejects enabled creation', async () => {
    installWorkspace('admin');
    await installExactMcpRequirement();
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
        return missingConnectionResponse();
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const preview = await callController(
      previewWorkflowSchedule,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    assert.equal(preview.statusCode, 200);
    assert.equal((preview.body as { valid: boolean }).valid, false);
    assert.ok((preview.body as { errors: Array<{ field: string }> }).errors.some((error) => error.field === 'mcpReadiness'));

    const created = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    assert.equal(created.statusCode, 409);
    assert.equal((created.body as { error: { code: string } }).error.code, 'MCP_CONNECTION_REQUIRED');
    const listed = await callController(listWorkspaceWorkflowSchedules, createRequest({ workspaceId: 'workspace-1' }));
    assert.deepEqual((listed.body as { items: unknown[] }).items, []);
  });

  it('allows a paused draft but blocks enabling it until its user MCP connection is ready', async () => {
    installWorkspace('admin');
    await installExactMcpRequirement();
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
        return missingConnectionResponse();
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const created = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput(false))
    );
    assert.equal(created.statusCode, 201);
    const scheduleId = (created.body as { schedule: { id: string; status: string } }).schedule.id;
    assert.equal((created.body as { schedule: { status: string } }).schedule.status, 'paused');

    const enabled = await callController(
      updateWorkflowSchedule,
      createRequest({ scheduleId }, { workspaceId: 'workspace-1', enabled: true })
    );
    assert.equal(enabled.statusCode, 409);
    assert.equal((enabled.body as { error: { code: string } }).error.code, 'MCP_CONNECTION_REQUIRED');
  });

  it('auto-pauses before run creation when exact user MCP readiness fails', async () => {
    installWorkspace('admin');
    const { repo } = await import('../src/store/repository.js');
    const auditEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
    const insertAuditEvent = repo.insertWorkspaceAuditEvent;
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push(event);
      return insertAuditEvent(event);
    };
    await installExactMcpRequirement();
    const readinessRequests: Array<Record<string, unknown>> = [];
    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
        readinessRequests.push(JSON.parse(String(init.body)));
        return readinessRequests.length === 1
          ? new Response(JSON.stringify({ ready: true, failures: [] }), { status: 200 })
          : missingConnectionResponse();
      }
      if (url === `${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs` && init?.method === 'POST') {
        executionDispatches.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const created = await callController(createWorkflowScheduleForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      scheduleInput()
    ));
    const schedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;

    const result = await runWorkflowScheduleTick({ now: new Date(schedule.nextRunAt) });

    assert.equal(result.dispatched, 0);
    assert.equal(result.autoPaused, 1);
    assert.equal(executionDispatches.length, 0);
    assert.deepEqual(readinessRequests, [{
      workspace_id: 'workspace-1',
      principal: { type: 'user', id: 'user-1' },
      tool_refs: [
        { server_id: 'server-1', tool_name: 'records.list' },
        { server_id: 'builtin-server-1', tool_name: 'list_resources' }
      ]
    }, {
      workspace_id: 'workspace-1',
      principal: { type: 'user', id: 'user-1' },
      tool_refs: [
        { server_id: 'server-1', tool_name: 'records.list' },
        { server_id: 'builtin-server-1', tool_name: 'list_resources' }
      ]
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
    assert.equal(audit?.metadata?.readinessCode, 'MCP_CONNECTION_REQUIRED');
  });

  it('auto-pauses when the active workflow parameter set changes', async () => {
    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async () => createReadyMcpReadinessResponse());
    const { repo } = await import('../src/store/repository.js');
    const auditEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
    const insertAuditEvent = repo.insertWorkspaceAuditEvent;
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push(event);
      return insertAuditEvent(event);
    };
    const created = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    assert.equal(created.statusCode, 201);
    const schedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;
    await db.query(
      `UPDATE workflow_definitions
       SET prompt='Treat {{text:target}} as ordinary text.',
           resource_requirements='[]'::jsonb,
           version=version+1
       WHERE workspace_id='workspace-1' AND id='cluster-triage'`
    );

    const result = await runWorkflowScheduleTick({ now: new Date(schedule.nextRunAt) });

    assert.equal(result.autoPaused, 1);
    const listed = await callController(
      listWorkspaceWorkflowSchedules,
      createRequest({ workspaceId: 'workspace-1' })
    );
    const paused = (listed.body as { items: Array<{ id: string; status: string; lastStatus?: string }> }).items
      .find((item) => item.id === schedule.id);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.lastStatus, 'auto_paused');
    const audit = auditEvents.find((event) => event.eventType === 'workflow.schedule_auto_paused.v1');
    assert.equal(audit?.metadata?.reason, 'workflow_parameters_changed');
  });

  it('auto-pauses when a stored resource is no longer authorized', async () => {
    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async () => createReadyMcpReadinessResponse());
    const created = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    assert.equal(created.statusCode, 201);
    const schedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;
    await db.query(
      `UPDATE workflow_definitions
       SET resource_requirements=$3::jsonb
       WHERE workspace_id=$1 AND id=$2`,
      [
        'workspace-1',
        'cluster-triage',
        JSON.stringify([{
          type: 'target',
          minimum: 1,
          maximum: 1,
          requiredOperations: ['read'],
          constraints: { targetIds: ['different-target'] }
        }])
      ]
    );

    const result = await runWorkflowScheduleTick({ now: new Date(schedule.nextRunAt) });

    assert.equal(result.autoPaused, 1);
    const listed = await callController(
      listWorkspaceWorkflowSchedules,
      createRequest({ workspaceId: 'workspace-1' })
    );
    const paused = (listed.body as { items: Array<{ id: string; status: string; lastError?: string }> }).items
      .find((item) => item.id === schedule.id);
    assert.equal(paused?.status, 'paused');
    assert.match(paused?.lastError || '', /outside this Workflow resource policy/);
  });

  it('auto-pauses when a stored resource no longer exists', async () => {
    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async () => createReadyMcpReadinessResponse());
    const created = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    assert.equal(created.statusCode, 201);
    const schedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;
    await db.query("DELETE FROM targets WHERE workspace_id='workspace-1' AND id='cluster-1'");

    const result = await runWorkflowScheduleTick({ now: new Date(schedule.nextRunAt) });

    assert.equal(result.autoPaused, 1);
    const listed = await callController(
      listWorkspaceWorkflowSchedules,
      createRequest({ workspaceId: 'workspace-1' })
    );
    const paused = (listed.body as { items: Array<{ id: string; status: string; lastError?: string }> }).items
      .find((item) => item.id === schedule.id);
    assert.equal(paused?.status, 'paused');
    assert.match(paused?.lastError || '', /does not exist in this workspace/);
  });

  it('immediately pauses enabled schedules when an Agent changes to individual MCP credentials', async () => {
    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async () => createReadyMcpReadinessResponse());
    const { repo } = await import('../src/store/repository.js');
    const auditEvents: Array<{
      eventType: string;
      objectId?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const insertAuditEvent = repo.insertWorkspaceAuditEvent;
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push(event);
      return insertAuditEvent(event);
    };
    const enabled = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    const alreadyPaused = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, { ...scheduleInput(false), name: 'Already paused schedule' })
    );
    assert.equal(enabled.statusCode, 201);
    assert.equal(alreadyPaused.statusCode, 201);
    const enabledId = (enabled.body as { schedule: { id: string } }).schedule.id;
    const alreadyPausedId = (alreadyPaused.body as { schedule: { id: string } }).schedule.id;

    const pausedIds = await pauseSchedulesForAgentIndividualCredentials({
      workspaceId: 'workspace-1',
      agentId: 'agent-cluster-triage',
      serverId: 'server-1',
      serverName: 'Records MCP',
      actorUserId: 'user-1'
    });

    assert.deepEqual(pausedIds, [enabledId]);
    const listed = await callController(
      listWorkspaceWorkflowSchedules,
      createRequest({ workspaceId: 'workspace-1' })
    );
    const schedules = (listed.body as {
      items: Array<{ id: string; status: string; lastStatus?: string; lastError?: string; lastRunAt?: string }>;
    }).items;
    const paused = schedules.find((schedule) => schedule.id === enabledId);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.lastStatus, 'auto_paused');
    assert.match(paused?.lastError || '', /server-1 now uses individual credentials/);
    assert.equal(paused?.lastRunAt, undefined);
    assert.equal(schedules.find((schedule) => schedule.id === alreadyPausedId)?.lastStatus, undefined);

    const audit = auditEvents.find((event) => (
      event.eventType === 'workflow.schedule_auto_paused.v1' && event.objectId === enabledId
    ));
    assert.equal(audit?.metadata?.reason, 'mcp_credential_mode_changed');
    assert.equal(audit?.metadata?.agentId, 'agent-cluster-triage');
    assert.equal(audit?.metadata?.serverId, 'server-1');
  });

  it('immediately pauses enabled schedules when a target server changes to individual credentials', async () => {
    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async () => createReadyMcpReadinessResponse());
    const enabled = await callController(
      createWorkflowScheduleForWorkspace,
      createRequest({ workspaceId: 'workspace-1' }, scheduleInput())
    );
    assert.equal(enabled.statusCode, 201);
    const enabledId = (enabled.body as { schedule: { id: string } }).schedule.id;
    mock.restoreAll();
    await installExactMcpRequirement();
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/internal/mcp/connections/readiness') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ready: false, failures: [{
          server_id: 'builtin-server-1',
          tool_name: 'list_resources',
          code: 'MCP_CONNECTION_MISSING',
          action: 'connect_mcp_server'
        }] }), { status: 200 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const pausedIds = await pauseSchedulesForTargetIndividualCredentials({
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      serverId: 'builtin-server-1',
      serverName: 'AcornOps Kubernetes Tools',
      actorUserId: 'user-1'
    });

    assert.deepEqual(pausedIds, [enabledId]);
    const listed = await callController(
      listWorkspaceWorkflowSchedules,
      createRequest({ workspaceId: 'workspace-1' })
    );
    const paused = (listed.body as { items: Array<{ id: string; status: string; lastError?: string }> }).items
      .find((schedule) => schedule.id === enabledId);
    assert.equal(paused?.status, 'paused');
    assert.match(paused?.lastError || '', /AcornOps Kubernetes Tools now uses individual credentials/);
  });
});
