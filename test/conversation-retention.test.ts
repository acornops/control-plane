import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  purgeOldWorkspaceAuditEvents,
  runControlPlaneRetentionSweep
} from '../src/services/conversation-retention.js';
import { repo } from '../src/store/repository.js';

describe('conversation retention service', () => {
  it('purges old workspace audit events in bounded batches', async () => {
    const originalPurge = repo.purgeOldWorkspaceAuditEvents;
    const calls: Array<{ retentionDays: number; limit: number }> = [];

    repo.purgeOldWorkspaceAuditEvents = async (retentionDays: number, limit?: number) => {
      calls.push({ retentionDays, limit: limit ?? 0 });
      return calls.length === 1 ? 500 : 25;
    };

    try {
      const purged = await purgeOldWorkspaceAuditEvents();

      assert.equal(purged, 525);
      assert.deepEqual(calls, [
        { retentionDays: 365, limit: 500 },
        { retentionDays: 365, limit: 500 }
      ]);
    } finally {
      repo.purgeOldWorkspaceAuditEvents = originalPurge;
    }
  });

  it('continues later retention tasks when one cleanup task fails', async () => {
    const calls: string[] = [];

    await runControlPlaneRetentionSweep({
      conversations: async () => {
        calls.push('conversations');
        throw new Error('conversation purge unavailable');
      },
      webhookHistory: async () => {
        calls.push('webhook_history');
        return 0;
      },
      workspaceAuditEvents: async () => {
        calls.push('workspace_audit_events');
        return 0;
      }
    });

    assert.deepEqual(calls, ['conversations', 'webhook_history', 'workspace_audit_events']);
  });
});
