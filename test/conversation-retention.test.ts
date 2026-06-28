import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  purgeOrphanedSkillSnapshotBlobs,
  purgeOldTargetMetricHistory,
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

  it('purges old target metric history in bounded batches', async () => {
    const originalPurge = repo.purgeOldTargetMetricHistory;
    const calls: Array<{ retentionDays: number; limit: number }> = [];

    repo.purgeOldTargetMetricHistory = async (retentionDays: number, limit?: number) => {
      calls.push({ retentionDays, limit: limit ?? 0 });
      return calls.length === 1 ? 500 : 10;
    };

    try {
      const purged = await purgeOldTargetMetricHistory();

      assert.equal(purged, 510);
      assert.deepEqual(calls, [
        { retentionDays: 30, limit: 500 },
        { retentionDays: 30, limit: 500 }
      ]);
    } finally {
      repo.purgeOldTargetMetricHistory = originalPurge;
    }
  });

  it('purges orphaned skill snapshot blobs in bounded batches', async () => {
    const originalPurge = repo.purgeOrphanedSkillSnapshotBlobs;
    const calls: Array<{ retentionDays: number; limit: number }> = [];

    repo.purgeOrphanedSkillSnapshotBlobs = async (retentionDays: number, limit?: number) => {
      calls.push({ retentionDays, limit: limit ?? 0 });
      return calls.length === 1 ? 500 : 7;
    };

    try {
      const purged = await purgeOrphanedSkillSnapshotBlobs();

      assert.equal(purged, 507);
      assert.deepEqual(calls, [
        { retentionDays: 7, limit: 500 },
        { retentionDays: 7, limit: 500 }
      ]);
    } finally {
      repo.purgeOrphanedSkillSnapshotBlobs = originalPurge;
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
      },
      externalIntegrationLinkTokens: async () => {
        calls.push('external_integration_link_tokens');
        return 0;
      },
      targetMetricHistory: async () => {
        calls.push('target_metric_history');
        return 0;
      },
      skillSnapshotBlobs: async () => {
        calls.push('skill_snapshot_blobs');
        return 0;
      }
    });

    assert.deepEqual(calls, [
      'conversations',
      'webhook_history',
      'workspace_audit_events',
      'external_integration_link_tokens',
      'target_metric_history',
      'skill_snapshot_blobs'
    ]);
  });
});
