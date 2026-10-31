import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  purgeOrphanedSkillSnapshotBlobs,
  purgeExpiredToolResultArtifacts,
  purgeOldTargetMetricHistory,
  purgeOldWorkspaceAuditEvents,
  runControlPlaneRetentionSweep
} from '../src/services/conversation-retention.js';
import { repo } from '../src/store/repository.js';
import * as retention from '../src/services/conversation-retention.js';

describe('conversation retention service', () => {
  it('uses thirty days and caps workflow cleanup at twenty batches of fifty sessions', async () => {
    const original = repo.purgeExpiredWorkflowHistory;
    const calls: number[] = [];
    repo.purgeExpiredWorkflowHistory = async (days, limit) => {
      assert.equal(days, 30);
      assert.equal(limit, 50);
      calls.push(days);
      return 50;
    };
    try {
      assert.equal(await retention.purgeExpiredWorkflowHistory(), 1000);
      assert.equal(calls.length, 20);
      repo.purgeExpiredWorkflowHistory = async () => 3;
      assert.equal(await retention.purgeExpiredWorkflowHistory(), 3);
    } finally {
      repo.purgeExpiredWorkflowHistory = original;
    }
  });
  it('caps generated document cleanup at twenty batches and stops when caught up', async () => {
    const original = repo.purgeExpiredGeneratedDocuments;
    const calls: Array<number | undefined> = [];
    repo.purgeExpiredGeneratedDocuments = async limit => {
      calls.push(limit);
      return 500;
    };
    try {
      assert.equal(await retention.purgeExpiredGeneratedDocuments(), 10_000);
      assert.equal(calls.length, 20);
      assert(calls.every(limit => limit === 500));
      calls.length = 0;
      repo.purgeExpiredGeneratedDocuments = async limit => {
        calls.push(limit);
        return calls.length === 1 ? 500 : 3;
      };
      assert.equal(await retention.purgeExpiredGeneratedDocuments(), 503);
      assert.equal(calls.length, 2);
      repo.purgeExpiredGeneratedDocuments = async () => 0;
      assert.equal(await retention.purgeExpiredGeneratedDocuments(), 0);
    } finally {
      repo.purgeExpiredGeneratedDocuments = original;
    }
  });
  it('caps issue observation cleanup at twenty batches and stops when caught up', async () => {
    const original = repo.purgeOldTargetIssueObservations;
    const calls: Array<{ retentionDays: number; limit?: number }> = [];
    repo.purgeOldTargetIssueObservations = async (retentionDays, limit) => {
      calls.push({ retentionDays, limit });
      return 500;
    };
    try {
      assert.equal(await retention.purgeOldTargetIssueObservations(), 10_000);
      assert.equal(calls.length, 20);
      assert(calls.every(call => call.retentionDays === 30 && call.limit === 500));
      calls.length = 0;
      repo.purgeOldTargetIssueObservations = async () => {
        calls.push({ retentionDays: 30 });
        return calls.length === 1 ? 500 : 25;
      };
      assert.equal(await retention.purgeOldTargetIssueObservations(), 525);
      assert.equal(calls.length, 2);
    } finally {
      repo.purgeOldTargetIssueObservations = original;
    }
  });
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

  it('purges expired tool result artifacts in bounded batches', async () => {
    const originalPurge = repo.purgeExpiredToolResultArtifacts;
    let calls = 0;
    repo.purgeExpiredToolResultArtifacts = async () => (++calls === 1 ? 500 : 3);
    try {
      assert.equal(await purgeExpiredToolResultArtifacts(), 503);
      assert.equal(calls, 2);
    } finally {
      repo.purgeExpiredToolResultArtifacts = originalPurge;
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
      workflowHistory: async () => {
        calls.push('workflow_history');
        throw new Error('workflow purge unavailable');
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
      targetIssueObservations: async () => {
        calls.push('target_issue_observations');
        throw new Error('observation purge unavailable');
      },
      skillSnapshotBlobs: async () => {
        calls.push('skill_snapshot_blobs');
        return 0;
      },
      toolResultArtifacts: async () => {
        calls.push('tool_result_artifacts');
        return 0;
      },
      generatedDocuments: async () => {
        calls.push('generated_documents');
        throw new Error('document purge unavailable');
      }
    });

    assert.deepEqual(calls, [
      'conversations',
      'workflow_history',
      'webhook_history',
      'workspace_audit_events',
      'external_integration_link_tokens',
      'target_metric_history',
      'target_issue_observations',
      'skill_snapshot_blobs',
      'generated_documents',
      'tool_result_artifacts'
    ]);
  });
});
