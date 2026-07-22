import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  publicRunApproval,
  publicRunEvent,
  publicWorkflowExecutionEvent,
  publicWorkflowRun
} from '../src/controllers/external-run-public.js';
import type { WorkflowRunRecord } from '../src/store/repository-workflow-runs.js';

describe('external run public projections', () => {
  it('keeps approval controls while removing executable arguments and results', () => {
    const approval = publicRunApproval({
      id: 'approval-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'kubernetes',
      toolCallId: 'tool-call-private',
      toolName: 'restart_service',
      toolRef: { serverId: 'private-server', toolName: 'restart_service' },
      requestedToolAlias: 'private-alias',
      argumentsDigest: 'private-digest',
      summary: 'Restart the selected service.',
      arguments: { unit: 'private.service', credential: 'must-not-leak' },
      status: 'approved',
      executionStatus: 'succeeded',
      toolResult: { stdout: 'private result' },
      toolResultIsError: false,
      requestedBy: 'private-requester',
      decidedBy: 'private-decider',
      decision: 'approved',
      createdAt: '2026-07-23T00:00:00.000Z',
      decidedAt: '2026-07-23T00:01:00.000Z',
      expiresAt: '2026-07-23T00:15:00.000Z'
    });

    assert.deepEqual(approval, {
      id: 'approval-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'kubernetes',
      toolName: 'restart_service',
      summary: 'Restart the selected service.',
      status: 'approved',
      executionStatus: 'succeeded',
      decision: 'approved',
      createdAt: '2026-07-23T00:00:00.000Z',
      decidedAt: '2026-07-23T00:01:00.000Z',
      expiresAt: '2026-07-23T00:15:00.000Z'
    });
  });

  it('removes token, reasoning, and tool-result payloads while preserving approval controls', () => {
    const token = publicRunEvent({
      schema_version: 1,
      run_id: 'run-1',
      seq: 1,
      ts: '2026-07-23T00:00:00.000Z',
      type: 'assistant_token_delta',
      payload: { delta: 'private answer token' }
    });
    assert.deepEqual(token.payload, {});

    const approval = publicRunEvent({
      ...token,
      seq: 2,
      type: 'tool_approval_requested',
      payload: {
        approval_id: 'approval-1',
        tool: 'reports.pdf.generate',
        summary: 'Generate the approved report.',
        expires_at: '2026-07-23T00:15:00.000Z',
        arguments: { secret: 'must-not-leak' }
      }
    });
    assert.deepEqual(approval.payload, {
      approval_id: 'approval-1',
      tool: 'reports.pdf.generate',
      summary: 'Generate the approved report.',
      expires_at: '2026-07-23T00:15:00.000Z'
    });
  });

  it('sanitizes nested aggregate run events and cross-origin run state', () => {
    const event = publicWorkflowExecutionEvent({
      id: '4',
      schemaVersion: 1,
      executionId: 'execution-1',
      type: 'run_event',
      occurredAt: '2026-07-23T00:00:00.000Z',
      runId: 'run-1',
      runEventSeq: 3,
      payload: {
        runEvent: {
          schema_version: 1,
          run_id: 'run-1',
          seq: 3,
          ts: '2026-07-23T00:00:00.000Z',
          type: 'tool_call_completed',
          payload: { result: 'private tool output' }
        }
      }
    });
    assert.deepEqual((event.payload.runEvent as { payload: unknown }).payload, {});

    const run = publicWorkflowRun({
      id: 'run-1', workflowRunId: 'execution-1', executionId: 'execution-1', workspaceId: 'workspace-1',
      workflowId: 'workflow-1', workflowSessionId: 'session-private', attemptNumber: 1,
      idempotencyKey: 'private-key', messageId: 'message-private', createdBy: 'user-1', status: 'completed',
      compiledAccessScope: {} as WorkflowRunRecord['compiledAccessScope'], prompt: 'private prompt',
      promptDigest: 'digest', bindingDigest: 'binding', resourceBindings: [], resolvedAt: '2026-07-23T00:00:00.000Z',
      requestedAt: '2026-07-23T00:00:00.000Z', assistantMessage: { content: 'private result' },
      createdAt: '2026-07-23T00:00:00.000Z'
    }, false);
    const serialized = JSON.stringify(run);
    for (const privateValue of ['private prompt', 'private result', 'private-key', 'session-private', 'message-private']) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });
});
