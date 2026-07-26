import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { db } from '../src/infra/db.js';
import {
  getWorkflowActivityByIssueIds,
  listWorkspaceWorkflowExecutions
} from '../src/store/repository-workflow-activity.js';
import type {
  WorkflowExecutionOrigin,
  WorkflowExecutionStatus
} from '../src/types/workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
after(closeAutomationDatabaseFixtures);

async function insertActivityExecution(input: {
  id: string;
  workspaceId?: string;
  status: WorkflowExecutionStatus;
  workflowName: string;
  origin: WorkflowExecutionOrigin;
  createdAt: string;
  targetId?: string;
  issueId?: string;
}): Promise<void> {
  const workspaceId = input.workspaceId || 'workspace-1';
  const sessionId = `session-${input.id}`;
  const messageId = `message-${input.id}`;
  const runId = `run-${input.id}`;
  await db.query(
    `INSERT INTO workflow_sessions (
       id,workspace_id,workflow_id,workflow_version,created_by,compiled_access_scope,workflow_snapshot
     ) VALUES ($1,$2,'cluster-triage',3,'user-1','{}'::jsonb,$3)`,
    [sessionId, workspaceId, { id: 'cluster-triage', name: input.workflowName }]
  );
  await db.query(
    `INSERT INTO workflow_messages (
       id,session_id,workspace_id,workflow_id,role,content,created_at
     ) VALUES ($1,$2,$3,'cluster-triage','user','Inspect the target.',$4)`,
    [messageId, sessionId, workspaceId, input.createdAt]
  );
  await db.query(
    `INSERT INTO workflow_executions (
       id,workspace_id,workflow_id,workflow_version,workflow_session_id,message_id,created_by,
       trigger_type,origin_snapshot,source_type,source_id,status,workflow_snapshot,
       started_at,ended_at,created_at,updated_at
     ) VALUES (
       $1,$2,'cluster-triage',3,$3,$4,'user-1',$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$13
     )`,
    [
      input.id,
      workspaceId,
      sessionId,
      messageId,
      input.origin.kind === 'schedule'
        ? 'schedule'
        : input.origin.kind === 'event_trigger'
          ? 'acornops_event'
          : 'manual',
      input.origin,
      input.issueId ? 'issue' : null,
      input.issueId || null,
      input.status,
      { id: 'cluster-triage', name: input.workflowName },
      input.createdAt,
      ['completed', 'failed', 'cancelled'].includes(input.status) ? input.createdAt : null,
      input.createdAt
    ]
  );
  await db.query(
    `INSERT INTO workflow_runs (
       id,execution_id,workspace_id,workflow_id,workflow_session_id,message_id,created_by,status,
       compiled_access_scope,requested_at,started_at,ended_at,attempt_number,executor_role,
       agent_id,agent_version,executor_snapshot,target_id,target_type,idempotency_key,resolved_at
     ) VALUES (
       $1,$2,$3,'cluster-triage',$4,$5,'user-1',$6,'{}'::jsonb,$7,$7,$8,1,'specialist',
       'agent-cluster-triage',2,'{"role":"specialist"}'::jsonb,$9,$10,$11,$7
     )`,
    [
      runId,
      input.id,
      workspaceId,
      sessionId,
      messageId,
      input.status,
      input.createdAt,
      ['completed', 'failed', 'cancelled'].includes(input.status) ? input.createdAt : null,
      input.targetId || null,
      input.targetId ? 'kubernetes' : null,
      `activity-${input.id}`
    ]
  );
  await db.query('UPDATE workflow_messages SET run_id=$1 WHERE id=$2', [runId, messageId]);
}

async function seedActivityExecutions(): Promise<void> {
  await insertActivityExecution({
    id: 'execution-scheduled',
    status: 'running',
    workflowName: 'Scheduled diagnostics',
    origin: {
      schemaVersion: 1,
      kind: 'schedule',
      label: 'Hourly diagnostics',
      triggerId: 'schedule-hourly'
    },
    targetId: 'cluster-1',
    createdAt: '2026-07-25T05:00:00.000Z'
  });
  await insertActivityExecution({
    id: 'execution-approval',
    status: 'waiting_for_approval',
    workflowName: 'Issue remediation',
    origin: {
      schemaVersion: 1,
      kind: 'event_trigger',
      label: 'Critical issue automation',
      triggerId: 'trigger-critical',
      source: { kind: 'issue', label: 'Issue event', id: 'issue-1' }
    },
    issueId: 'issue-1',
    targetId: 'cluster-1',
    createdAt: '2026-07-25T04:00:00.000Z'
  });
  await insertActivityExecution({
    id: 'execution-review',
    status: 'needs_review',
    workflowName: 'Issue evidence collection',
    origin: {
      schemaVersion: 1,
      kind: 'event_trigger',
      label: 'Issue evidence trigger',
      triggerId: 'trigger-evidence',
      source: { kind: 'issue', label: 'Issue event', id: 'issue-1' }
    },
    issueId: 'issue-1',
    targetId: 'cluster-1',
    createdAt: '2026-07-25T03:00:00.000Z'
  });
  await insertActivityExecution({
    id: 'execution-completed',
    status: 'completed',
    workflowName: 'Completed issue triage',
    origin: {
      schemaVersion: 1,
      kind: 'event_trigger',
      label: 'Issue triage trigger',
      triggerId: 'trigger-triage',
      source: { kind: 'issue', label: 'Issue event', id: 'issue-2' }
    },
    issueId: 'issue-2',
    targetId: 'cluster-1',
    createdAt: '2026-07-25T02:00:00.000Z'
  });
  await insertActivityExecution({
    id: 'execution-failed',
    status: 'failed',
    workflowName: 'Manual investigation',
    origin: { schemaVersion: 1, kind: 'manual', label: 'Manual' },
    targetId: 'cluster-1',
    createdAt: '2026-07-25T01:00:00.000Z'
  });
  await insertActivityExecution({
    id: 'execution-other-workspace',
    workspaceId: 'workspace-2',
    status: 'running',
    workflowName: 'Other workspace run',
    origin: { schemaVersion: 1, kind: 'manual', label: 'Manual' },
    targetId: 'cluster-2',
    createdAt: '2026-07-25T06:00:00.000Z'
  });
}

describe('workspace workflow activity persistence', () => {
  it('filters and paginates executions with workspace-scoped navigation counts', async () => {
    await seedActivityExecutions();

    const first = await listWorkspaceWorkflowExecutions('workspace-1', {
      limit: 2,
      signature: 'all'
    });
    assert.deepEqual(first.items.map((item) => item.id), [
      'execution-scheduled',
      'execution-approval'
    ]);
    assert.equal(first.items[0]?.rootRun?.targetName, 'Test Cluster');
    assert.ok(first.nextCursor);
    assert.deepEqual(first.summary, {
      openCount: 3,
      attentionCount: 2,
      latestUpdatedAt: '2026-07-25T05:00:00.000Z'
    });

    const second = await listWorkspaceWorkflowExecutions('workspace-1', {
      limit: 2,
      signature: 'all',
      cursor: {
        createdAt: first.items.at(-1)!.createdAt,
        executionId: first.items.at(-1)!.id
      }
    });
    assert.deepEqual(second.items.map((item) => item.id), [
      'execution-review',
      'execution-completed'
    ]);
    assert.equal(second.items.some((item) => item.workspaceId === 'workspace-2'), false);

    const schedule = await listWorkspaceWorkflowExecutions('workspace-1', {
      limit: 20,
      origin: 'schedule'
    });
    assert.deepEqual(schedule.items.map((item) => item.id), ['execution-scheduled']);

    const attention = await listWorkspaceWorkflowExecutions('workspace-1', {
      limit: 20,
      state: 'attention'
    });
    assert.deepEqual(attention.items.map((item) => item.id), [
      'execution-approval',
      'execution-review'
    ]);

    const workflowSearch = await listWorkspaceWorkflowExecutions('workspace-1', {
      limit: 20,
      search: 'manual investigation'
    });
    assert.deepEqual(workflowSearch.items.map((item) => item.id), ['execution-failed']);

    const targetSearch = await listWorkspaceWorkflowExecutions('workspace-1', {
      limit: 20,
      search: 'test cluster'
    });
    assert.equal(targetSearch.items.length, 5);
  });

  it('summarizes zero, one, and multiple issue executions without per-issue queries', async () => {
    await seedActivityExecutions();
    const activity = await getWorkflowActivityByIssueIds(
      'workspace-1',
      ['issue-0', 'issue-1', 'issue-2']
    );

    assert.equal(activity.has('issue-0'), false);
    assert.deepEqual(
      {
        totalCount: activity.get('issue-1')?.totalCount,
        openCount: activity.get('issue-1')?.openCount,
        attentionCount: activity.get('issue-1')?.attentionCount,
        openId: activity.get('issue-1')?.openExecution?.id,
        latestId: activity.get('issue-1')?.latestExecution.id
      },
      {
        totalCount: 2,
        openCount: 2,
        attentionCount: 2,
        openId: 'execution-approval',
        latestId: 'execution-approval'
      }
    );
    assert.deepEqual(
      {
        totalCount: activity.get('issue-2')?.totalCount,
        openCount: activity.get('issue-2')?.openCount,
        attentionCount: activity.get('issue-2')?.attentionCount,
        latestId: activity.get('issue-2')?.latestExecution.id
      },
      { totalCount: 1, openCount: 0, attentionCount: 0, latestId: 'execution-completed' }
    );
  });
});
