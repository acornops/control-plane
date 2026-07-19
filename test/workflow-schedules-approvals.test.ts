import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { decideRunApproval } from '../src/controllers/runs-controller.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import {
  createWorkflowScheduleForWorkspace,
  deleteWorkflowSchedule,
  listWorkspaceApprovalInbox,
  listWorkspaceWorkflowSchedules,
  previewWorkflowSchedule,
  updateWorkflowSchedule
} from '../src/controllers/workflow-schedules-controller.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { runWorkflowScheduleTick } from '../src/services/workflow-scheduler.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import {
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  getWorkflowDefinition,
  listWorkflowRunApprovals
} from '../src/store/repository-workflows.js';
import {
  computeNextWorkflowScheduleRunAt
} from '../src/store/repository-workflow-schedules.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import type { Run, RunToolApproval } from '../src/types/domain.js';
import {
  callController,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

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

function createTargetRunApproval(overrides: Partial<RunToolApproval> = {}): RunToolApproval {
  return {
    id: 'target-approval-1',
    runId: 'target-run-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    toolCallId: 'call-1',
    toolName: 'restart_workload',
    summary: 'Restart workload default/web.',
    arguments: {},
    status: 'pending',
    executionStatus: 'not_started',
    requestedBy: 'user-2',
    createdAt: '2026-06-27T00:00:00.000Z',
    expiresAt: '2026-06-27T00:10:00.000Z',
    ...overrides
  };
}

function createTargetRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'target-run-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    toolAccessMode: 'read_write',
    status: 'waiting_for_approval',
    requestedAt: '2026-06-27T00:00:00.000Z',
    ...overrides
  };
}

describe('workflow schedules and approval inbox', () => {
  it('computes next schedule due time in the stored timezone', () => {
    assert.equal(
      computeNextWorkflowScheduleRunAt('0 9 * * *', new Date('2026-01-01T00:30:00.000Z'), 'Asia/Singapore'),
      '2026-01-01T01:00:00.000Z'
    );
  });

  it('requires manage_workflows to create, update, and delete schedules', async () => {
    installWorkspace('operator');

    const createDenied = await callController(createWorkflowScheduleForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: 'cluster-triage',
        name: 'Hourly triage',
        cron: '0 * * * *',
        timezone: 'UTC',
        inputDefaults: { targetId: 'cluster-1' },
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));

    assert.equal(createDenied.statusCode, 403);
    assert.equal((createDenied.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('previews valid schedules without mutating schedule state', async () => {
    installWorkspace('admin');
    const response = await callController(previewWorkflowSchedule, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: 'cluster-triage',
        name: 'Weekday triage',
        cron: '0 9 * * 1-5',
        timezone: 'UTC',
        inputDefaults: { targetId: 'cluster-1', severity: 'high' },
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));

    assert.equal(response.statusCode, 200);
    const body = response.body as { valid: boolean; summary: string; nextRunTimes: string[]; errors: unknown[] };
    assert.equal(body.valid, true);
    assert.match(body.summary, /Weekdays at 09:00/);
    assert.equal(body.nextRunTimes.length, 5);
    assert.deepEqual(body.errors, []);
    const listed = await callController(listWorkspaceWorkflowSchedules, createRequest({ workspaceId: 'workspace-1' }));
    assert.deepEqual((listed.body as { items: unknown[] }).items, []);
  });

  it('returns field errors for invalid schedule previews', async () => {
    installWorkspace('admin');
    const response = await callController(previewWorkflowSchedule, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: 'cluster-triage',
        cron: 'invalid',
        timezone: 'Not/AZone',
        inputDefaults: {},
        approvedContextGrants: ['unapproved_context']
      }
    ));

    assert.equal(response.statusCode, 200);
    const body = response.body as { valid: boolean; nextRunTimes: string[]; errors: Array<{ field: string }> };
    assert.equal(body.valid, false);
    assert.deepEqual(body.nextRunTimes, []);
    assert.ok(body.errors.some((error) => error.field === 'cron'));
    assert.ok(body.errors.some((error) => error.field === 'timezone'));
    assert.ok(body.errors.some((error) => error.field === 'approvedContextGrants'));
  });

  it('creates, lists, pauses, and deletes workflow schedules for authorized users', async () => {
    installWorkspace('admin');

    const created = await callController(createWorkflowScheduleForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: 'cluster-triage',
        name: 'Hourly triage',
        cron: '0 * * * *',
        timezone: 'UTC',
        enabled: true,
        principal: { type: 'user', id: 'user-1' },
        inputDefaults: { targetId: 'cluster-1' },
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));

    assert.equal(created.statusCode, 201);
    const schedule = (created.body as { schedule: { id: string; workflowVersion: number; nextRunAt: string } }).schedule;
    assert.equal(schedule.workflowVersion, 3);
    assert.ok(schedule.nextRunAt);

    const listed = await callController(listWorkspaceWorkflowSchedules, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.body as { items: unknown[]; summary: { active: number } }).items.length, 1);
    assert.equal((listed.body as { summary: { active: number } }).summary.active, 1);

    const paused = await callController(updateWorkflowSchedule, createRequest(
      { scheduleId: schedule.id },
      { workspaceId: 'workspace-1', enabled: false }
    ));
    assert.equal(paused.statusCode, 200);
    assert.equal((paused.body as { schedule: { status: string } }).schedule.status, 'paused');

    const deleted = await callController(deleteWorkflowSchedule, createRequest(
      { scheduleId: schedule.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deleted.statusCode, 204);
  });

  it('rejects service identities for workflow schedules', async () => {
    installWorkspace('admin');
    const response = await callController(createWorkflowScheduleForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: 'cluster-triage',
        name: 'Service schedule',
        cron: '0 * * * *',
        timezone: 'UTC',
        principal: { type: 'service_identity', id: 'service-1' }
      }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'WORKFLOW_SCHEDULE_USER_PRINCIPAL_REQUIRED'
    );
  });

  it('dispatches due schedules into workflow runs and records dispatch status', async () => {
    installWorkspace('admin');
    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
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
        name: 'Due triage',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: true,
        principal: { type: 'user', id: 'user-1' },
        inputDefaults: { targetId: 'cluster-1' },
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    const createdSchedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;
    const scheduleId = createdSchedule.id;

    const tickNow = new Date(createdSchedule.nextRunAt);
    const result = await runWorkflowScheduleTick({ now: tickNow });

    assert.equal(result.claimed, 1);
    assert.equal(result.dispatched, 1);
    assert.equal(await runAutomationOutboxTick(), 1);
    assert.equal(executionDispatches.length, 1);
    const listed = await callController(listWorkspaceWorkflowSchedules, createRequest({ workspaceId: 'workspace-1' }));
    const schedule = (listed.body as { items: Array<{ id: string; lastStatus?: string; lastRunAt?: string }> }).items.find((item) => item.id === scheduleId);
    assert.equal(schedule?.lastStatus, 'dispatched');
    assert.equal(schedule?.lastRunAt, tickNow.toISOString());
  });

  it('auto-pauses a delegated user schedule after the user loses run permission', async () => {
    installWorkspace('admin');
    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
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
        name: 'Due triage',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: true,
        principal: { type: 'user', id: 'user-1' },
        inputDefaults: { targetId: 'cluster-1' },
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    const createdSchedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;
    const scheduleId = createdSchedule.id;
    installWorkspace('viewer');

    const result = await runWorkflowScheduleTick({ now: new Date(createdSchedule.nextRunAt) });

    assert.equal(result.dispatched, 0);
    assert.equal(result.autoPaused, 1);
    assert.equal(await runAutomationOutboxTick(), 0);
    assert.equal(executionDispatches.length, 0);
    const listed = await callController(listWorkspaceWorkflowSchedules, createRequest({ workspaceId: 'workspace-1' }));
    const schedule = (listed.body as { items: Array<{ id: string; status: string; lastStatus?: string }> }).items.find((item) => item.id === scheduleId);
    assert.equal(schedule?.status, 'paused');
    assert.equal(schedule?.lastStatus, 'auto_paused');
  });

  it('lists target approvals and workflow approval gates in one workspace inbox', async () => {
    installWorkspace('admin');
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const entryAgent = await getAgentDefinition('workspace-1', workflow.entryAgentId);
    assert.ok(entryAgent);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow: {
        ...workflow,
        capabilityPolicy: {
          ...workflow.capabilityPolicy,
          mode: 'read_write',
          approvalRequirements: ['Before running write-capable workflow automation']
        }
      },
      entryAgent,
      mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }),
      exactTargets: [{ id: 'cluster-1', targetType: 'kubernetes' }],
      actor: {
        userId: 'user-1',
        role: 'admin',
        permissions: getWorkspacePermissions('admin')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = await createWorkflowSession({ workflow: { ...workflow, capabilityPolicy: { ...workflow.capabilityPolicy, mode: 'read_write', approvalRequirements: ['Before running write-capable workflow automation'] } }, createdBy: 'user-1', compiledAccessScope });
    const message = await createWorkflowUserMessage({ session, content: 'Run gated workflow' });
    const run = await createWorkflowRun({ session, message });
    const workflowApproval = (await listWorkflowRunApprovals(run.id))[0];

    const targetApproval = createTargetRunApproval();
    const targetRun = createTargetRun();
    const { repo } = await import('../src/store/repository.js');
    repo.listWorkspaceRunToolApprovals = async () => [targetApproval];
    repo.countPendingWorkspaceRunToolApprovals = async (workspaceId: string) => workspaceId === 'workspace-1' ? 1 : 0;
    repo.getRun = async (runId: string) => runId === targetRun.id ? targetRun : null;

    const response = await callController(listWorkspaceApprovalInbox, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as { pendingCount: number; items: Array<{ approvalId: string; source: string; runId: string; status: string }> };
    assert.equal(body.pendingCount, 2);
    assert.deepEqual(body.items.map((item) => item.source).sort(), ['target_tool', 'workflow_gate']);
    assert.ok(body.items.some((item) => item.approvalId === workflowApproval.id && item.runId === run.id));
    assert.ok(body.items.some((item) => item.approvalId === targetApproval.id && item.runId === targetRun.id));

    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
    const decided = await callController(decideRunApproval, createRequest(
      { runId: run.id, approvalId: workflowApproval.id },
      { decision: 'approved' }
    ));
    assert.equal(decided.statusCode, 200);
  });

  it('returns zero pending approvals when both normalized sources are empty', async () => {
    installWorkspace('admin');
    const { repo } = await import('../src/store/repository.js');
    repo.listWorkspaceRunToolApprovals = async () => [];
    repo.countPendingWorkspaceRunToolApprovals = async () => 0;

    const request = createRequest({ workspaceId: 'workspace-1' });
    request.query = { status: 'all' };
    const response = await callController(listWorkspaceApprovalInbox, request);

    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { items: unknown[] }).items, []);
    assert.equal((response.body as { pendingCount: number }).pendingCount, 0);
  });

  it('keeps pendingCount independent of decided filtering, pagination, cursor, and limit', async () => {
    installWorkspace('admin');
    const observed: Array<{ workspaceId: string; status?: string; limit?: number; cursor?: string }> = [];
    const { repo } = await import('../src/store/repository.js');
    repo.listWorkspaceRunToolApprovals = async (params) => {
      observed.push(params);
      return [createTargetRunApproval({ status: 'approved', decision: 'approved' })];
    };
    repo.countPendingWorkspaceRunToolApprovals = async (workspaceId: string) => workspaceId === 'workspace-1' ? 101 : 0;

    const request = createRequest({ workspaceId: 'workspace-1' });
    request.query = { status: 'decided', limit: '1', cursor: '2026-06-28T00:00:00.000Z' };
    const response = await callController(listWorkspaceApprovalInbox, request);

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { pendingCount: number }).pendingCount, 101);
    assert.deepEqual(observed, [{
      workspaceId: 'workspace-1',
      status: 'decided',
      limit: 1,
      cursor: '2026-06-28T00:00:00.000Z'
    }]);
  });

  it('preserves workspace-data authorization before querying approval counts', async () => {
    installWorkspace('auditor');
    let queried = false;
    const { repo } = await import('../src/store/repository.js');
    repo.listWorkspaceRunToolApprovals = async () => { queried = true; return []; };
    repo.countPendingWorkspaceRunToolApprovals = async () => { queried = true; return 0; };

    const response = await callController(listWorkspaceApprovalInbox, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 403);
    assert.equal(queried, false);
  });
});
