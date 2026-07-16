import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  insertWorkspaceAuditEvent,
  purgeOldWorkspaceAuditEvents,
  sanitizeAuditMetadata,
  shouldPersistWorkspaceAuditEvent
} from '../src/store/repository-audit-events.js';

describe('workspace audit repository helpers', () => {
  it('redacts sensitive metadata fields before persistence', () => {
    assert.deepEqual(
      sanitizeAuditMetadata({
        role: 'auditor',
        token: 'raw-token',
        catalogReason: 'tool_setting_updated',
        nested: {
          authorization: 'Bearer secret',
          content: 'message body',
          safe: 'kept'
        },
        arguments: { namespace: 'default' },
        longValue: 'x'.repeat(1100)
      }),
      {
        role: 'auditor',
        token: '[redacted]',
        catalogReason: 'tool_setting_updated',
        nested: {
          authorization: '[redacted]',
          content: '[redacted]',
          safe: 'kept'
        },
        arguments: '[redacted]',
        longValue: `${'x'.repeat(1024)}...`
      }
    );
  });

  it('applies audit logging mode policy by operation', () => {
    assert.equal(shouldPersistWorkspaceAuditEvent({ operation: 'read' }, 'read_write'), true);
    assert.equal(shouldPersistWorkspaceAuditEvent({ operation: 'write' }, 'read_write'), true);
    assert.equal(shouldPersistWorkspaceAuditEvent({ operation: 'read' }, 'write_only'), false);
    assert.equal(shouldPersistWorkspaceAuditEvent({ operation: 'write' }, 'write_only'), true);
    assert.equal(shouldPersistWorkspaceAuditEvent({ operation: 'read' }, 'disabled'), false);
    assert.equal(shouldPersistWorkspaceAuditEvent({ operation: 'write' }, 'disabled'), false);
  });

  it('skips filtered audit events before sanitizing or inserting', async () => {
    let queryCount = 0;
    const queryable = {
      async query() {
        queryCount += 1;
        throw new Error('query should not run');
      }
    };

    const result = await insertWorkspaceAuditEvent(
      {
        workspaceId: 'ws-1',
        category: 'tool',
        eventType: 'tool.called.v1',
        operation: 'read',
        actorType: 'system',
        objectType: 'tool_call',
        summary: 'Read tool called',
        metadata: { token: 'raw-token' }
      },
      queryable,
      'write_only'
    );

    assert.equal(result, null);
    assert.equal(queryCount, 0);
  });

  it('persists retained events with operation and sanitized metadata', async () => {
    let capturedParams: unknown[] = [];
    const queryable = {
      async query(_sql: string, params?: unknown[]) {
        capturedParams = params || [];
        return {
          rows: [
            {
              id: 'audit-1',
              workspace_id: 'ws-1',
              category: 'tool',
              event_type: 'tool.called.v1',
              operation: 'write',
              actor_type: 'system',
              actor_user_id: null,
              actor_token_id: null,
              actor_email: null,
              actor_display_name: null,
              object_type: 'tool_call',
              object_id: null,
              object_name: null,
              summary: 'Write tool called',
              metadata: { token: '[redacted]' },
              occurred_at: '2026-06-01T00:00:00.000Z'
            }
          ]
        };
      }
    };

    const event = await insertWorkspaceAuditEvent(
      {
        workspaceId: 'ws-1',
        category: 'tool',
        eventType: 'tool.called.v1',
        operation: 'write',
        actorType: 'system',
        objectType: 'tool_call',
        summary: 'Write tool called',
        metadata: { token: 'raw-token' }
      },
      queryable,
      'write_only'
    );

    assert.equal(event?.operation, 'write');
    assert.equal(capturedParams[4], 'write');
    assert.deepEqual(JSON.parse(capturedParams[12] as string), { token: '[redacted]' });
  });

  it('retains linked user and integration client attribution for external integration actors', async () => {
    let capturedParams: unknown[] = [];
    const queryable = {
      async query(_sql: string, params?: unknown[]) {
        capturedParams = params || [];
        return {
          rows: [{
            id: 'audit-external-1',
            workspace_id: 'ws-1',
            category: 'run',
            event_type: 'workflow.run_created.v1',
            operation: 'write',
            actor_type: 'external_integration',
            actor_user_id: 'user-1',
            actor_token_id: 'integration-client-1',
            actor_email: null,
            actor_display_name: null,
            object_type: 'workflow_run',
            object_id: 'run-1',
            object_name: null,
            summary: 'Workflow run created',
            metadata: {},
            occurred_at: '2026-06-01T00:00:00.000Z'
          }]
        };
      }
    };

    const event = await insertWorkspaceAuditEvent({
      workspaceId: 'ws-1',
      category: 'run',
      eventType: 'workflow.run_created.v1',
      operation: 'write',
      actorType: 'external_integration',
      actorUserId: 'user-1',
      actorTokenId: 'integration-client-1',
      objectType: 'workflow_run',
      objectId: 'run-1',
      summary: 'Workflow run created'
    }, queryable, 'write_only');

    assert.equal(capturedParams[6], 'user-1');
    assert.equal(capturedParams[7], 'integration-client-1');
    assert.deepEqual(event?.actor, {
      type: 'external_integration',
      userId: 'user-1',
      tokenId: 'integration-client-1'
    });
  });

  it('purges old workspace audit events with defensive retention and batch limits', async () => {
    let capturedParams: unknown[] = [];
    const queryable = {
      async query(sql: string, params?: unknown[]) {
        assert.match(sql, /DELETE FROM workspace_audit_events/);
        assert.match(sql, /occurred_at < NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
        capturedParams = params || [];
        return { rows: [{ deleted_count: 7 }] };
      }
    };

    const purged = await purgeOldWorkspaceAuditEvents(0, 10000, queryable);

    assert.equal(purged, 7);
    assert.deepEqual(capturedParams, [1, 5000]);
  });
});
