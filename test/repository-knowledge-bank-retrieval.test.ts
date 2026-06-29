import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { searchKnowledgeBankSnippets } from '../src/store/repository-knowledge-bank.js';

afterEach(() => {
  mock.restoreAll();
});

function createKnowledgeRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-06-29T01:00:00.000Z');
  return {
    id: 'entry-1',
    workspace_id: 'workspace-1',
    target_id: 'target-1',
    target_type: 'kubernetes',
    title: 'Vendor approval exception routing',
    status: 'active',
    body_markdown: 'Vendors are routed to manual review when approval metadata is missing.',
    frontmatter: {},
    tags: [],
    signals: {},
    scope: {},
    evidence_summary: 'Approval skipped because vendor metadata was incomplete.',
    observation_count: 2,
    confidence: 0.4,
    first_observed_at: now,
    last_observed_at: now,
    created_at: now,
    updated_at: now,
    rank: 0,
    tag_overlap: 0,
    signal_overlap: 0,
    scope_overlap: 0,
    strong_text_term_overlap: 0,
    text_term_overlap: 2,
    scope_specificity: 0,
    ...overrides
  };
}

describe('Knowledge Bank retrieval query', () => {
  it('allows extracted strong terms to match through a separate one-term lane', async () => {
    let capturedParams: unknown[] | undefined;
    let capturedSql = '';
    mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rowCount: 0, rows: [] };
    });

    await searchKnowledgeBankSnippets(
      'workspace-1',
      'target-1',
      'Do we have knowledge bank about crashloopbackoff?',
      { limit: 4, maxSnippetSizeBytes: 1536 }
    );

    assert.match(capturedSql, /text_term_overlap/);
    assert.match(capturedSql, /strong_text_term_overlap > 0/);
    assert.match(capturedSql, /allow_direct_text_match/);
    assert.match(capturedSql, /\(search\.allow_direct_text_match AND scored\.search_document @@ search\.query\)/);
    assert.match(capturedSql, /\(search\.allow_direct_text_match AND POSITION\(LOWER\(\$3\) IN scored\.search_text\) > 0\)/);
    assert.match(capturedSql, /POSITION\(term IN e\.search_text\) > 0/);
    assert.doesNotMatch(capturedSql, /search_text LIKE/);
    assert.deepEqual(capturedParams?.[4], ['crashloopbackoff']);
    assert.deepEqual(capturedParams?.[5], ['crashloopbackoff']);
    assert.equal(capturedParams?.[6], 2);
  });

  it('requires two ordinary terms for controlled text overlap', async () => {
    let capturedParams: unknown[] | undefined;
    mock.method(db, 'query', async (_sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rowCount: 0, rows: [] };
    });

    await searchKnowledgeBankSnippets(
      'workspace-1',
      'target-1',
      'Why did vendor approval get skipped?',
      { limit: 4, maxSnippetSizeBytes: 1536 }
    );

    assert.deepEqual(capturedParams?.[4], ['vendor', 'approval', 'skipped']);
    assert.deepEqual(capturedParams?.[5], []);
    assert.equal(capturedParams?.[6], 2);
  });

  it('keeps broad one-word text queries below the controlled overlap threshold', async () => {
    let capturedParams: unknown[] | undefined;
    mock.method(db, 'query', async (_sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rowCount: 0, rows: [] };
    });

    await searchKnowledgeBankSnippets(
      'workspace-1',
      'target-1',
      'Tell me about automation',
      { limit: 4, maxSnippetSizeBytes: 1536 }
    );

    assert.deepEqual(capturedParams?.[4], ['automation']);
    assert.deepEqual(capturedParams?.[5], []);
    assert.equal(capturedParams?.[6], 2);
  });

  it('includes controlled text overlap in snippet scoring', async () => {
    mock.method(db, 'query', async () => ({
      rowCount: 1,
      rows: [createKnowledgeRow({ text_term_overlap: 3, strong_text_term_overlap: 0 })]
    }));

    const snippets = await searchKnowledgeBankSnippets(
      'workspace-1',
      'target-1',
      'Why did vendor approval get skipped?',
      { limit: 4, maxSnippetSizeBytes: 1536 }
    );

    assert.equal(snippets.length, 1);
    assert.equal(snippets[0]?.title, 'Vendor approval exception routing');
    assert.ok(snippets[0]?.score && snippets[0].score > 0.6);
  });
});
