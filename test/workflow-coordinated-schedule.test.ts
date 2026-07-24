import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import { delegateSpecialist } from '../src/controllers/internal-delegation-controller.js';
import { createWorkflowScheduleForWorkspace } from '../src/controllers/workflow-schedules-controller.js';
import { db } from '../src/infra/db.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { promptResourceRegistry } from '../src/services/prompt-resources/index.js';
import { runWorkflowScheduleTick } from '../src/services/workflow-scheduler.js';
import { createWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  callController,
  createReadyMcpReadinessResponse,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isMcpReadinessRequest,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
afterEach(restoreControllerRegressionState);
after(closeAutomationDatabaseFixtures);

describe('coordinated Workflow schedules', () => {
  it('pins the Agent ceiling and delegates from immutable resource bindings', async () => {
    installWorkspace('admin');
    await db.query(
      `INSERT INTO workspace_memberships (workspace_id,user_id,role)
       VALUES ('workspace-1','user-1','admin')`
    );
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      if (isMcpReadinessRequest(input, init)) return createReadyMcpReadinessResponse();
      if (url === `${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs` && init?.method === 'POST') {
        return new Response(null, { status: 202 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });
    const workflow = await createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Scheduled coordination',
      prompt: 'Inspect @target[] using a specialist.',
      agentIds: ['agent-cluster-triage', 'agent-incident-reporter'],
      resourceRequirements: [{
        type: 'target',
        minimum: 1,
        maximum: 1,
        requiredOperations: ['read'],
        constraints: { targetTypes: ['kubernetes'], targetIds: [] }
      }],
      capabilityPolicy: {
        mode: 'read_only',
        restrictionMode: 'restrict',
        semanticCapabilityIds: ['target.diagnostics.read'],
        contextGrants: ['workspace_metadata', 'target_inventory'],
        maxRuntimeSeconds: 300,
        retentionDays: 30,
        approvalRequirements: []
      },
      requiredPermissions: ['read_workspace_data'],
      createdBy: 'user-1',
      status: 'active'
    });
    const created = await callController(createWorkflowScheduleForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      {
        workflowId: workflow.id,
        name: 'Coordinated due schedule',
        cron: '* * * * *',
        timezone: 'UTC',
        enabled: true,
        principal: { type: 'user', id: 'user-1' },
        controlMessage: 'Inspect @target[Test Cluster] using a specialist.',
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    assert.equal(created.statusCode, 201);
    const schedule = (created.body as { schedule: { id: string; nextRunAt: string } }).schedule;

    const tick = await runWorkflowScheduleTick({ now: new Date(schedule.nextRunAt) });
    assert.equal(tick.dispatched, 1);
    assert.equal(await runAutomationOutboxTick(), 1);
    const persisted = await db.query<{
      run_id: string;
      executor_role: string;
      run_selected_agents: unknown[];
      ceiling_selected_agents: unknown[];
    }>(
      `SELECT run.id AS run_id,
              run.executor_role,
              run.compiled_access_scope->'selectedAgentSnapshots' AS run_selected_agents,
              session.compiled_access_scope->'selectedAgentSnapshots' AS ceiling_selected_agents
       FROM workflow_executions execution
       JOIN workflow_runs run ON run.execution_id=execution.id AND run.parent_run_id IS NULL
       JOIN workflow_sessions session ON session.id=execution.workflow_session_id
       WHERE execution.trigger_id=$1`,
      [schedule.id]
    );
    assert.equal(persisted.rows[0].executor_role, 'coordinator');
    assert.deepEqual(persisted.rows[0].run_selected_agents, []);
    assert.equal(persisted.rows[0].ceiling_selected_agents.length, 2);
    mock.method(promptResourceRegistry, 'resolve', async () => {
      throw new Error('Delegation must use the immutable parent resource bindings.');
    });

    const delegated = await callController(delegateSpecialist, createRequest(
      { runId: persisted.rows[0].run_id },
      {
        toolCallId: 'scheduled-delegation-1',
        capabilityId: 'target.diagnostics.read',
        targetBinding: { id: 'cluster-1', targetType: 'kubernetes' },
        taskPrompt: 'Inspect the scheduled target.',
        required: true
      }
    ));
    assert.equal(delegated.statusCode, 201);
    const child = await db.query<{ parent_run_id: string; executor_role: string; agent_id: string }>(
      'SELECT parent_run_id,executor_role,agent_id FROM workflow_runs WHERE id=$1',
      [(delegated.body as { childRunId: string }).childRunId]
    );
    assert.deepEqual(child.rows[0], {
      parent_run_id: persisted.rows[0].run_id,
      executor_role: 'specialist',
      agent_id: 'agent-cluster-triage'
    });
  });
});
