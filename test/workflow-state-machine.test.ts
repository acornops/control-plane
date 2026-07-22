import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { resumeWorkflowExecution } from '../src/services/workflow-state-machine.js';
import type { CompiledWorkflowAccessScope } from '../src/types/workflows.js';

afterEach(() => {
  mock.restoreAll();
});

describe('workflow retry state machine', () => {
  it('persists the freshly authorized prompt bindings and digest on the new attempt', async () => {
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
        if (sql.includes('INSERT INTO workflow_approvals')) approvalInsert = params;
        if (sql.includes('UPDATE workflow_executions SET status=')) executionUpdate = params;
        return { rowCount: 1, rows: [] };
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    const binding = {
      bindingId: 'prb_retry',
      type: 'chat',
      resourceId: 'chat-1',
      provider: 'acornops.chat',
      providerVersion: '1',
      workspaceId: 'workspace-1',
      labelSnapshot: 'Incident room',
      source: 'explicit' as const,
      operations: ['read'],
      contextMode: 'tool' as const
    };
    const compiledAccessScope = {
      approvalGates: ['Confirm retry'],
      resourceBindings: [binding],
      promptDigest: 'prompt-digest-new',
      bindingDigest: 'binding-digest-new'
    } as unknown as CompiledWorkflowAccessScope;

    const result = await resumeWorkflowExecution('execution-1', 'user-2', {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      workflowSessionId: 'session-1',
      messageId: 'message-1',
      agentId: 'agent-2',
      agentVersion: 4,
      agentSnapshot: { id: 'agent-2', version: 4 },
      targetId: 'target-2',
      targetType: 'virtual_machine',
      compiledAccessScope,
      prompt: 'Retry with @chat[Incident room].',
      promptDigest: 'prompt-digest-new',
      bindingDigest: 'binding-digest-new',
      resourceBindings: [binding],
      resolvedAt: '2026-07-20T10:00:00.000Z'
    });

    assert.equal(result.status, 'waiting_for_approval');
    assert(runInsert);
    assert.equal(runInsert[5], 2);
    assert.equal(runInsert[6], 'agent-2');
    assert.equal(runInsert[11], 'execution-1:prompt-digest-new:binding-digest-new:entry:2');
    assert.equal(runInsert[14], 'waiting_for_approval');
    assert.equal(runInsert[15], compiledAccessScope);
    assert.equal(runInsert[20], 'Retry with @chat[Incident room].');
    assert.equal(runInsert[21], 'prompt-digest-new');
    assert.equal(runInsert[22], 'binding-digest-new');
    assert.deepEqual(JSON.parse(String(runInsert[23])), [binding]);
    assert.equal(runInsert[24], '2026-07-20T10:00:00.000Z');
    assert(approvalInsert);
    assert.deepEqual(executionUpdate, ['execution-1', 'waiting_for_approval']);
  });
});
