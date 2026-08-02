import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { resumeWorkflowExecution } from '../src/services/workflow-state-machine.js';
import type { CompiledWorkflowAccessScope } from '../src/types/workflows.js';

afterEach(() => {
  mock.restoreAll();
});

describe('workflow retry state machine', () => {
  it('persists the prompt snapshot on the new attempt', async () => {
    let runInsert: unknown[] | undefined;
    let executionUpdate: unknown[] | undefined;
    let approvalInsert: unknown[] | undefined;
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('SELECT * FROM workflow_executions')) {
          return { rowCount: 1, rows: [{ id: 'execution-1', status: 'failed' }] };
        }
        if (sql.includes('SELECT * FROM workflow_runs')) {
          return {
            rowCount: 1,
            rows: [{
              workspace_id: 'workspace-1',
              workflow_id: 'workflow-1',
              workflow_session_id: 'session-1',
              message_id: 'message-1',
              attempt_number: 1,
              uncertain_write: false,
              llm_provider: 'openai',
              llm_model: 'gpt-test',
              llm_reasoning_summary_mode: 'concise',
              llm_reasoning_effort: 'medium'
            }]
          };
        }
        if (sql.includes('INSERT INTO workflow_runs')) runInsert = params;
        if (sql.includes('INSERT INTO workflow_run_approvals')) {
          approvalInsert = params;
          return {
            rowCount: 1,
            rows: [{
              id: params[0],
              tool_name: 'workflow.approval_gate',
              summary: params[4],
              status: 'pending',
              expires_at: '2026-07-20T10:15:00.000Z'
            }]
          };
        }
        if (sql.includes('INSERT INTO workflow_execution_events')) {
          return { rowCount: 1, rows: [{ id: params[2] === 'run_created' ? 1 : 2 }] };
        }
        if (sql.includes('SELECT event.*')) {
          return {
            rowCount: 1,
            rows: [{
              id: params[0],
              execution_id: 'execution-1',
              event_type: params[0] === 1 ? 'run_created' : 'approval_requested',
              occurred_at: '2026-07-20T10:00:00.000Z',
              payload: {}
            }]
          };
        }
        if (sql.includes('UPDATE workflow_executions SET status=')) executionUpdate = params;
        return { rowCount: 1, rows: [] };
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    const compiledAccessScope = {
      approvalGates: ['Confirm retry'],
      executor: { role: 'specialist', agentId: 'agent-2' }
    } as unknown as CompiledWorkflowAccessScope;

    const result = await resumeWorkflowExecution('execution-1', 'user-2', {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      workflowSessionId: 'session-1',
      messageId: 'message-1',
      executorRole: 'specialist',
      specialistSnapshot: { id: 'agent-2' } as never,
      compiledAccessScope,
      prompt: 'Retry with @chat[Incident room].'
    });

    assert.equal(result.status, 'waiting_for_approval');
    assert(runInsert);
    assert.equal(runInsert[5], 2);
    assert.equal(runInsert[6], 'specialist');
    assert.equal(runInsert[7], 'agent-2');
    assert.equal(runInsert[9], 'execution-1:root:2');
    assert.equal(runInsert[12], 'waiting_for_approval');
    assert.equal(runInsert[13], compiledAccessScope);
    assert.equal(runInsert[18], 'Retry with @chat[Incident room].');
    assert(approvalInsert);
    assert.deepEqual(executionUpdate, ['execution-1', 'waiting_for_approval']);
  });
});
