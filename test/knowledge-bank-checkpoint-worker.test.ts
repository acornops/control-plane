import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { runKnowledgeBankCheckpointSweep } from '../src/services/knowledge-bank/checkpoint-worker.js';
import { repo } from '../src/store/repository.js';

afterEach(() => {
  mock.restoreAll();
});

function checkpointJob(lastActivityAt: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes' as const,
    sessionId: 'session-1',
    lastActivityAt,
    leaseOwner: 'lease-1',
    config: {},
    toolEnabled: true,
    sessionActive: true,
    sessionLastMessageAt: lastActivityAt,
    hasActiveRun: false,
    hasPendingApproval: false,
    ...overrides
  };
}

function mockSingleClaim(job: ReturnType<typeof checkpointJob>): void {
  let claimed = false;
  mock.method(repo, 'claimDueKnowledgeBankCheckpointJobs', async (limit) => {
    assert.equal(limit, 1);
    if (claimed) return [];
    claimed = true;
    return [job];
  });
}

function mockAuditSink(): void {
  mock.method(repo, 'insertWorkspaceAuditEvent', async (event) => ({
    id: 'audit-1',
    workspaceId: event.workspaceId,
    category: event.category,
    eventType: event.eventType,
    actor: { type: event.actorType || 'system' },
    object: { type: event.objectType, id: event.objectId },
    summary: event.summary,
    metadata: event.metadata || {},
    occurredAt: '2026-06-29T01:00:00.000Z'
  }));
}

function mockRepositoryTransaction(): void {
  const client = {
    query: async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => undefined
  };
  mock.method(db, 'connect', async () => client);
}

function mockConfiguredGatewayResponse(patchPayload: unknown): void {
  mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/llm/provider-credentials?')) {
      return new Response(JSON.stringify({
        workspace_id: 'workspace-1',
        providers: [
          { provider: 'openai', enabled: true, configured: true },
          { provider: 'anthropic', enabled: true, configured: false },
          { provider: 'gemini', enabled: true, configured: false }
        ]
      }), { status: 200 });
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
          type: 'delta',
          text: JSON.stringify(patchPayload)
        })}`));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  });
}

describe('Knowledge Bank checkpoint worker', () => {
  it('reschedules a due job until the configured idle delay has elapsed', async () => {
    const rescheduledJobs: unknown[] = [];
    const lastActivityAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const job = checkpointJob(lastActivityAt);

    mockSingleClaim(job);
    mock.method(repo, 'rescheduleKnowledgeBankCheckpointJob', async (params) => {
      rescheduledJobs.push(params);
      return true;
    });
    const finishJob = mock.method(repo, 'finishKnowledgeBankCheckpointJob', async () => true);
    const listMessages = mock.method(repo, 'listMessages', async () => {
      throw new Error('messages should not be fetched before idle delay');
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(listMessages.mock.callCount(), 0);
    assert.equal(finishJob.mock.callCount(), 0);
    assert.deepEqual(rescheduledJobs, [{
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      sessionId: 'session-1',
      lastActivityAt,
      leaseOwner: 'lease-1',
      dueAt: new Date(new Date(lastActivityAt).getTime() + 30 * 60_000).toISOString(),
      error: 'idle_delay_pending'
    }]);
  });

  it('requeues stale jobs when newer session activity exists', async () => {
    const staleActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const newerActivityAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const upserts: unknown[] = [];
    const job = checkpointJob(staleActivityAt, { sessionLastMessageAt: newerActivityAt });

    mockSingleClaim(job);
    mock.method(repo, 'upsertKnowledgeBankCheckpointJobForSessionActivity', async (sessionId, activityAt) => {
      upserts.push({ sessionId, activityAt });
    });
    const finishJob = mock.method(repo, 'finishKnowledgeBankCheckpointJob', async () => true);
    const rescheduleJob = mock.method(repo, 'rescheduleKnowledgeBankCheckpointJob', async () => true);
    const listMessages = mock.method(repo, 'listMessages', async () => {
      throw new Error('messages should not be fetched for stale jobs');
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(listMessages.mock.callCount(), 0);
    assert.equal(finishJob.mock.callCount(), 0);
    assert.equal(rescheduleJob.mock.callCount(), 0);
    assert.deepEqual(upserts, [{ sessionId: 'session-1', activityAt: newerActivityAt }]);
  });

  it('defers jobs while a run or approval is active', async () => {
    const rescheduledJobs: unknown[] = [];
    const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const job = checkpointJob(lastActivityAt, { hasActiveRun: true });

    mockSingleClaim(job);
    mock.method(repo, 'rescheduleKnowledgeBankCheckpointJob', async (params) => {
      rescheduledJobs.push(params);
      return true;
    });
    const listMessages = mock.method(repo, 'listMessages', async () => {
      throw new Error('messages should not be fetched while a run is active');
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(listMessages.mock.callCount(), 0);
    assert.equal(rescheduledJobs.length, 1);
    assert.equal((rescheduledJobs[0] as { error: string }).error, 'run_active');
    assert.equal((rescheduledJobs[0] as { lastActivityAt: string }).lastActivityAt, lastActivityAt);
    assert.equal((rescheduledJobs[0] as { leaseOwner: string }).leaseOwner, 'lease-1');
  });

  it('marks AI settings skips as processed for unchanged sessions', async () => {
    const finishedJobs: unknown[] = [];
    const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const job = checkpointJob(lastActivityAt);

    mockSingleClaim(job);
    mock.method(repo, 'finishKnowledgeBankCheckpointJob', async (params) => {
      finishedJobs.push(params);
      return true;
    });
    mock.method(repo, 'getWorkspaceAiSettings', async () => null);
    const listMessages = mock.method(repo, 'listMessages', async () => {
      throw new Error('messages should not be fetched when learning is paused');
    });
    mockAuditSink();
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      workspace_id: 'workspace-1',
      providers: [
        { provider: 'openai', enabled: true, configured: false },
        { provider: 'anthropic', enabled: true, configured: false },
        { provider: 'gemini', enabled: true, configured: false }
      ]
    }), { status: 200 }));

    await runKnowledgeBankCheckpointSweep();

    assert.equal(listMessages.mock.callCount(), 0);
    assert.deepEqual(finishedJobs, [{
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      sessionId: 'session-1',
      lastActivityAt,
      leaseOwner: 'lease-1',
      status: 'skipped',
      error: 'ai_settings_missing',
      retryAfter: undefined
    }]);
  });

  it('generalizes repeated namespace-specific patches into an existing entry', async () => {
    const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const job = checkpointJob(lastActivityAt, {
      config: {
        learning: {
          idleCheckpointDelayMinutes: 30,
          minimumObservationsBeforeGeneralization: 3,
          checkpointModel: { mode: 'workspace_default' }
        },
        retrieval: {
          maxSnippetsPerRetrieval: 4,
          maxSnippetSizeBytes: 1536
        }
      }
    });
    const existingEntry = {
      id: 'entry-1',
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes' as const,
      title: 'Registry auth failures in namespace payments',
      status: 'pending' as const,
      bodyMarkdown: 'Refresh the image pull secret for the affected namespace.',
      frontmatter: {},
      tags: ['registry', '401'],
      signals: { error: '401', component: 'image-pull' },
      scope: { namespace: 'payments' },
      evidenceSummary: 'Pods in payments hit registry 401 responses.',
      observationCount: 2,
      confidence: 0.7,
      firstObservedAt: '2026-06-29T00:00:00.000Z',
      lastObservedAt: '2026-06-29T00:00:00.000Z',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z'
    };
    const updates: unknown[] = [];

    mockSingleClaim(job);
    mockRepositoryTransaction();
    mock.method(repo, 'finishKnowledgeBankCheckpointJob', async () => true);
    mock.method(repo, 'renewKnowledgeBankCheckpointJobLeaseIfCurrent', async () => true);
    mock.method(repo, 'getWorkspaceAiSettings', async () => null);
    mock.method(repo, 'listMessages', async () => ({
      items: [
        { role: 'user', content: 'Pods in namespace invoices are failing with registry 401 errors.' },
        { role: 'assistant', content: 'Refreshing the imagePullSecret fixed the invoices namespace.' }
      ]
    }));
    mock.method(repo, 'listKnowledgeBankEntries', async () => [existingEntry]);
    mock.method(repo, 'createKnowledgeBankEntry', async () => {
      throw new Error('repeated namespace evidence should update the existing entry');
    });
    mock.method(repo, 'updateKnowledgeBankEntry', async (_workspaceId, _targetId, entryId, patch) => {
      updates.push({ entryId, patch });
      return {
        ...existingEntry,
        ...patch,
        id: entryId,
        updatedAt: '2026-06-29T01:00:00.000Z'
      };
    });
    mockAuditSink();
    mockConfiguredGatewayResponse({
      patches: [{
        action: 'create',
        title: 'Registry auth failures across namespaces',
        bodyMarkdown: 'Refresh the image pull secret for affected namespaces.',
        tags: ['registry', '401'],
        signals: { error: '401', component: 'image-pull' },
        scope: { namespace: 'invoices' },
        evidenceSummary: 'Pods in invoices also hit registry 401 responses.',
        observationCount: 1,
        confidence: 0.8
      }]
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      entryId: 'entry-1',
      patch: {
        title: 'Registry auth failures across namespaces',
        bodyMarkdown: 'Refresh the image pull secret for affected namespaces.',
        status: 'active',
        tags: ['registry', '401'],
        evidenceSummary: 'Pods in payments hit registry 401 responses. Pods in invoices also hit registry 401 responses.',
        observationCount: 3,
        confidence: 0.8,
        signals: { error: '401', component: 'image-pull' },
        scope: {},
        lastObservedAt: lastActivityAt
      }
    });
  });

  it('does not demote active entries when an update patch omits status', async () => {
    const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const job = checkpointJob(lastActivityAt);
    const existingEntry = {
      id: 'entry-1',
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes' as const,
      title: 'Registry auth failures across namespaces',
      status: 'active' as const,
      bodyMarkdown: 'Refresh the image pull secret for affected namespaces.',
      frontmatter: {},
      tags: ['registry', '401'],
      signals: { error: '401', component: 'image-pull' },
      scope: {},
      evidenceSummary: 'Pods hit registry 401 responses.',
      observationCount: 4,
      confidence: 0.8,
      firstObservedAt: '2026-06-29T00:00:00.000Z',
      lastObservedAt: '2026-06-29T00:00:00.000Z',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z'
    };
    const updates: unknown[] = [];

    mockSingleClaim(job);
    mockRepositoryTransaction();
    mock.method(repo, 'finishKnowledgeBankCheckpointJob', async () => true);
    mock.method(repo, 'renewKnowledgeBankCheckpointJobLeaseIfCurrent', async () => true);
    mock.method(repo, 'getWorkspaceAiSettings', async () => null);
    mock.method(repo, 'listMessages', async () => ({
      items: [
        { role: 'user', content: 'Another namespace hit registry 401.' },
        { role: 'assistant', content: 'Refreshing the imagePullSecret fixed it again.' }
      ]
    }));
    mock.method(repo, 'listKnowledgeBankEntries', async () => [existingEntry]);
    mock.method(repo, 'updateKnowledgeBankEntry', async (_workspaceId, _targetId, entryId, patch) => {
      updates.push({ entryId, patch });
      return {
        ...existingEntry,
        ...patch,
        id: entryId,
        updatedAt: '2026-06-29T01:00:00.000Z'
      };
    });
    mockAuditSink();
    mockConfiguredGatewayResponse({
      patches: [{
        action: 'update',
        entryId: 'entry-1',
        evidenceSummary: 'A second namespace was fixed by refreshing imagePullSecret.',
        confidence: 0.85
      }]
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(updates.length, 1);
    assert.equal((updates[0] as { patch: Record<string, unknown> }).patch.status, undefined);
    assert.deepEqual(updates[0], {
      entryId: 'entry-1',
      patch: {
        evidenceSummary: 'A second namespace was fixed by refreshing imagePullSecret.',
        confidence: 0.85,
        lastObservedAt: lastActivityAt
      }
    });
  });

  it('does not apply patches when the checkpoint lease cannot be renewed after model work', async () => {
    const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const job = checkpointJob(lastActivityAt);
    const rescheduledJobs: unknown[] = [];
    const createEntry = mock.method(repo, 'createKnowledgeBankEntry', async () => {
      throw new Error('stale checkpoint workers must not write knowledge entries');
    });
    const updateEntry = mock.method(repo, 'updateKnowledgeBankEntry', async () => {
      throw new Error('stale checkpoint workers must not update knowledge entries');
    });

    mockSingleClaim(job);
    mockRepositoryTransaction();
    mock.method(repo, 'rescheduleKnowledgeBankCheckpointJob', async (params) => {
      rescheduledJobs.push(params);
      return false;
    });
    mock.method(repo, 'finishKnowledgeBankCheckpointJob', async () => true);
    mock.method(repo, 'renewKnowledgeBankCheckpointJobLeaseIfCurrent', async () => false);
    mock.method(repo, 'getWorkspaceAiSettings', async () => null);
    mock.method(repo, 'listMessages', async () => ({
      items: [
        { role: 'user', content: 'Pods in namespace invoices are failing with registry 401 errors.' },
        { role: 'assistant', content: 'Refreshing the imagePullSecret fixed the invoices namespace.' }
      ]
    }));
    mock.method(repo, 'listKnowledgeBankEntries', async () => []);
    mockConfiguredGatewayResponse({
      patches: [{
        action: 'create',
        title: 'Registry auth failures across namespaces',
        bodyMarkdown: 'Refresh the image pull secret for affected namespaces.',
        tags: ['registry', '401'],
        signals: { error: '401', component: 'image-pull' },
        evidenceSummary: 'Pods hit registry 401 responses.',
        observationCount: 3,
        confidence: 0.8
      }]
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(createEntry.mock.callCount(), 0);
    assert.equal(updateEntry.mock.callCount(), 0);
    assert.equal(rescheduledJobs.length, 1);
    assert.equal((rescheduledJobs[0] as { error: string }).error, 'state_changed');
    assert.equal((rescheduledJobs[0] as { leaseOwner: string }).leaseOwner, 'lease-1');
  });
});
