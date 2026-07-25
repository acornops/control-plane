import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { runTargetInsightsCheckpointSweep } from '../src/services/target-insights/checkpoint-worker.js';
import { repo } from '../src/store/repository.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

const hasIsolatedDatabase = Boolean(process.env.CONTROL_PLANE_TEST_DATABASE_URL);

function installDeterministicCheckpointProvider(): void {
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
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          type: 'delta',
          text: JSON.stringify({
            patches: [{
              action: 'create',
              title: 'Registry authentication failures',
              bodyMarkdown: 'Refresh the image pull secret when registry requests return HTTP 401.',
              tags: ['registry', '401', 'image-pull'],
              signals: { status: '401', component: 'image-pull' },
              evidenceSummary: 'Refreshing the image pull secret restored pod image pulls.',
              observationCount: 3,
              confidence: 0.9
            }]
          })
        })));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  });
}

describe('Target Insights checkpoint vertical integration', { skip: !hasIsolatedDatabase }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(closeAutomationDatabaseFixtures);

  it('persists, audits, and retrieves a checkpoint patch without waiting for the scheduler', async () => {
    const activityAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await db.query(
      `INSERT INTO target_tool_settings (target_id,tool_id,enabled,config_json)
       VALUES ($1,'target_insights',true,$2::jsonb)`,
      [
        'cluster-1',
        JSON.stringify({
          learning: {
            idleCheckpointDelayMinutes: 5,
            minimumObservationsBeforeGeneralization: 3,
            checkpointModel: { mode: 'workspace_default' }
          },
          retrieval: {
            maxSnippetsPerRetrieval: 4,
            maxSnippetSizeBytes: 1536
          }
        })
      ]
    );
    await db.query(
      `INSERT INTO sessions (
         id,workspace_id,target_id,created_by,title,status,created_at,updated_at,last_message_at,expires_at
       ) VALUES ($1,$2,$3,$4,$5,'open',$6,$6,$6,$7)`,
      ['session-insights-1', 'workspace-1', 'cluster-1', 'user-1', 'Diagnose registry failures', activityAt, expiresAt]
    );
    await db.query(
      `INSERT INTO messages (id,session_id,role,kind,content,created_at)
       VALUES
         ('message-insights-1','session-insights-1','user','user',$1,$3::timestamptz - interval '1 minute'),
         ('message-insights-2','session-insights-1','assistant','assistant_final',$2,$3::timestamptz)`,
      [
        'Pods fail to pull images with registry HTTP 401 responses.',
        'Refreshing the image pull secret restored image pulls.',
        activityAt
      ]
    );
    await db.query(
      `INSERT INTO target_insights_checkpoint_jobs (
         workspace_id,target_id,session_id,target_type,last_activity_at,due_at,status
       ) VALUES ('workspace-1','cluster-1','session-insights-1','kubernetes',$1,NOW(),'queued')`,
      [activityAt]
    );
    installDeterministicCheckpointProvider();

    await runTargetInsightsCheckpointSweep();

    const job = await db.query<{ status: string; last_error: string | null }>(
      `SELECT status,last_error
       FROM target_insights_checkpoint_jobs
       WHERE workspace_id='workspace-1' AND target_id='cluster-1' AND session_id='session-insights-1'`
    );
    assert.deepEqual(job.rows[0], { status: 'applied', last_error: null });

    const entries = await repo.listTargetInsightsEntries('workspace-1', 'cluster-1', { limit: 10 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'active');
    assert.equal(entries[0].title, 'Registry authentication failures');

    const snippets = await repo.searchTargetInsightsSnippets(
      'workspace-1',
      'cluster-1',
      'registry 401 image pull secret',
      { limit: 4, maxSnippetSizeBytes: 1536 }
    );
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0].entryId, entries[0].id);

    const activity = await repo.listWorkspaceAuditEvents('workspace-1', {
      category: 'insights',
      eventType: 'target_insights.checkpoint.applied.v1',
      metadataTargetId: 'cluster-1',
      limit: 10
    });
    assert.equal(activity.items.length, 1);
    assert.equal(activity.items[0].metadata.outcome, 'applied');
    assert.equal(activity.items[0].metadata.sessionId, 'session-insights-1');
    assert.equal(activity.items[0].metadata.appliedPatchCount, 1);
  });
});
