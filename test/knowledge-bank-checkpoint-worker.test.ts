import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { runKnowledgeBankCheckpointSweep } from '../src/services/knowledge-bank/checkpoint-worker.js';
import { repo } from '../src/store/repository.js';

afterEach(() => {
  mock.restoreAll();
});

describe('Knowledge Bank checkpoint worker', () => {
  it('releases the checkpoint lease until the configured idle delay has elapsed', async () => {
    const finishedCheckpoints: unknown[] = [];
    const lastMessageAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const candidate = {
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes' as const,
      sessionId: 'session-1',
      lastMessageAt,
      config: {}
    };

    mock.method(repo, 'listKnowledgeBankCheckpointCandidates', async () => [candidate]);
    mock.method(repo, 'claimKnowledgeBankCheckpoint', async () => true);
    mock.method(repo, 'finishKnowledgeBankCheckpoint', async (params) => {
      finishedCheckpoints.push(params);
    });
    const listMessages = mock.method(repo, 'listMessages', async () => {
      throw new Error('messages should not be fetched before idle delay');
    });

    await runKnowledgeBankCheckpointSweep();

    assert.equal(listMessages.mock.callCount(), 0);
    assert.equal(finishedCheckpoints.length, 1);
    assert.deepEqual(finishedCheckpoints[0], {
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      sessionId: 'session-1',
      status: 'skipped',
      error: 'idle_delay_pending',
      retryAfter: new Date(new Date(lastMessageAt).getTime() + 30 * 60_000).toISOString()
    });
  });

  it('marks AI settings skips as processed for unchanged sessions', async () => {
    const finishedCheckpoints: unknown[] = [];
    const lastMessageAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const candidate = {
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes' as const,
      sessionId: 'session-1',
      lastMessageAt,
      config: {}
    };

    mock.method(repo, 'listKnowledgeBankCheckpointCandidates', async () => [candidate]);
    mock.method(repo, 'claimKnowledgeBankCheckpoint', async () => true);
    mock.method(repo, 'finishKnowledgeBankCheckpoint', async (params) => {
      finishedCheckpoints.push(params);
    });
    mock.method(repo, 'getWorkspaceAiSettings', async () => null);
    const listMessages = mock.method(repo, 'listMessages', async () => {
      throw new Error('messages should not be fetched when learning is paused');
    });
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
    assert.deepEqual(finishedCheckpoints[0], {
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      sessionId: 'session-1',
      lastProcessedActivityAt: lastMessageAt,
      status: 'skipped',
      error: 'ai_settings_missing'
    });
  });

  it('generalizes repeated namespace-specific patches into an existing entry', async () => {
    const lastMessageAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const candidate = {
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes' as const,
      sessionId: 'session-1',
      lastMessageAt,
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
    };
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

    mock.method(repo, 'listKnowledgeBankCheckpointCandidates', async () => [candidate]);
    mock.method(repo, 'claimKnowledgeBankCheckpoint', async () => true);
    mock.method(repo, 'finishKnowledgeBankCheckpoint', async () => undefined);
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
      const patchPayload = {
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
      };
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
        lastObservedAt: lastMessageAt
      }
    });
  });

  it('does not demote active entries when an update patch omits status', async () => {
    const lastMessageAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const candidate = {
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes' as const,
      sessionId: 'session-1',
      lastMessageAt,
      config: {}
    };
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

    mock.method(repo, 'listKnowledgeBankCheckpointCandidates', async () => [candidate]);
    mock.method(repo, 'claimKnowledgeBankCheckpoint', async () => true);
    mock.method(repo, 'finishKnowledgeBankCheckpoint', async () => undefined);
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
      const patchPayload = {
        patches: [{
          action: 'update',
          entryId: 'entry-1',
          evidenceSummary: 'A second namespace was fixed by refreshing imagePullSecret.',
          confidence: 0.85
        }]
      };
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

    await runKnowledgeBankCheckpointSweep();

    assert.equal(updates.length, 1);
    assert.equal((updates[0] as { patch: Record<string, unknown> }).patch.status, undefined);
    assert.deepEqual(updates[0], {
      entryId: 'entry-1',
      patch: {
        evidenceSummary: 'A second namespace was fixed by refreshing imagePullSecret.',
        confidence: 0.85,
        lastObservedAt: lastMessageAt
      }
    });
  });
});
