import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  createRunSkillSnapshot,
  getRunSkillSnapshot,
  purgeOrphanedSkillSnapshotBlobs
} from '../src/store/repository-run-skill-snapshots.js';

afterEach(() => {
  mock.restoreAll();
});

function targetSkillRow(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 'skill-1',
    workspace_id: 'workspace-1',
    target_id: 'target-1',
    target_type: 'kubernetes',
    name: 'Skill',
    description: 'Skill description.',
    source_type: 'manual',
    enabled: true,
    validation_status: 'valid',
    validation_errors: [],
    file_count: 1,
    total_bytes: 16,
    source_repo_url: null,
    source_ref: null,
    source_subpath: null,
    source_commit_sha: null,
    sync_status: 'not_applicable',
    created_by: null,
    updated_by: null,
    created_at: '2026-06-28T00:00:00.000Z',
    updated_at: '2026-06-28T00:00:00.000Z',
    ...overrides
  };
}

describe('run skill snapshot repository', () => {
  it('freezes enabled valid skills with deterministic refs and content-only blob dedupe', async () => {
    const blobInserts: unknown[][] = [];
    const snapshotRows: Array<Record<string, unknown>> = [];
    const catalogRows: unknown[][] = [];
    const statements: string[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM runs r') && sql.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [{
              id: 'run-1',
              workspace_id: 'workspace-1',
              target_id: 'target-1',
              target_type: 'kubernetes'
            }]
          };
        }
        if (sql === 'SELECT run_id FROM run_skill_catalog_snapshots WHERE run_id = $1') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM target_skills s')) {
          return {
            rowCount: 2,
            rows: [
              targetSkillRow({ id: 'skill-b', name: 'Zeta debug', description: 'Different metadata.' }),
              targetSkillRow({ id: 'skill-a', name: 'alpha debug', description: 'Use for alpha.' })
            ]
          };
        }
        if (sql.includes('FROM target_skill_files')) {
          return {
            rowCount: 2,
            rows: [
              { skill_id: 'skill-b', path: 'SKILL.md', content: 'same frozen content', size_bytes: 19 },
              { skill_id: 'skill-a', path: 'SKILL.md', content: 'same frozen content', size_bytes: 19 }
            ]
          };
        }
        if (sql.includes('INSERT INTO skill_snapshot_blobs')) {
          blobInserts.push(params ?? []);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO run_skill_snapshots')) {
          const values = params ?? [];
          snapshotRows.push({
            run_id: values[0],
            skill_ref: values[1],
            skill_id: values[2],
            content_hash: values[3],
            name: values[4],
            description: values[5],
            source: JSON.parse(String(values[6])),
            file_count: values[7],
            total_bytes: values[8],
            created_at: '2026-06-28T00:00:00.000Z'
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO run_skill_catalog_snapshots')) {
          catalogRows.push(params ?? []);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('FROM run_skill_snapshots')) {
          return { rowCount: snapshotRows.length, rows: snapshotRows };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    const catalog = await createRunSkillSnapshot({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'kubernetes'
    });

    assert.equal(statements.at(-1), 'COMMIT');
    assert.deepEqual(catalog.map((entry) => [entry.ref, entry.skillId, entry.name]), [
      ['skill_1', 'skill-a', 'alpha debug'],
      ['skill_2', 'skill-b', 'Zeta debug']
    ]);
    assert.equal(blobInserts.length, 2);
    assert.equal(blobInserts[0][0], blobInserts[1][0]);
    assert.match(String(blobInserts[0][0]), /^sha256:/);
    assert.deepEqual(catalogRows[0], ['run-1', 'workspace-1', 'target-1', 'kubernetes', 2, 38]);
  });

  it('rejects snapshot creation when the locked run has a different target scope', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM runs r') && sql.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [{
              id: 'run-1',
              workspace_id: 'workspace-1',
              target_id: 'different-target',
              target_type: 'kubernetes'
            }]
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);

    await assert.rejects(
      createRunSkillSnapshot({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        targetId: 'target-1',
        targetType: 'kubernetes'
      }),
      /mismatched target scope/
    );
  });

  it('returns compact catalog rows in numeric skill ref order', async () => {
    mock.method(db, 'query', async (sql: string) => {
      if (sql.includes('FROM run_skill_snapshots')) {
        assert.match(sql, /substring\(skill_ref FROM 7\)::int ASC/);
        return {
          rowCount: 3,
          rows: [
            {
              run_id: 'run-1',
              skill_ref: 'skill_1',
              skill_id: 'skill-1',
              content_hash: 'sha256:1',
              name: 'One',
              description: 'First.',
              source: { type: 'manual', syncStatus: 'not_applicable' },
              file_count: 1,
              total_bytes: 1,
              created_at: '2026-06-28T00:00:00.000Z'
            }
          ]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { getRunSkillCatalog } = await import('../src/store/repository-run-skill-snapshots.js');
    const catalog = await getRunSkillCatalog('run-1');

    assert.deepEqual(catalog.map((entry) => entry.ref), ['skill_1']);
  });

  it('loads frozen files from snapshot tables without consulting live target skills', async () => {
    const statements: string[] = [];
    mock.method(db, 'query', async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM run_skill_snapshots s')) {
        return {
          rowCount: 1,
          rows: [
            {
              run_id: 'run-1',
              skill_ref: 'skill_1',
              skill_id: 'skill-old',
              content_hash: 'sha256:frozen',
              name: 'Frozen name',
              description: 'Frozen description.',
              source: { type: 'manual', syncStatus: 'not_applicable' },
              file_count: 1,
              total_bytes: 21,
              created_at: '2026-06-28T00:00:00.000Z',
              files: [{ path: 'SKILL.md', content: 'old frozen content', size_bytes: 21 }],
              blob_file_count: 1,
              blob_total_bytes: 21
            }
          ]
        };
      }
      if (sql.includes('UPDATE skill_snapshot_blobs')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const snapshot = await getRunSkillSnapshot('run-1', 'skill_1');

    assert.equal(snapshot?.skillId, 'skill-old');
    assert.equal(snapshot?.files[0]?.content, 'old frozen content');
    assert(statements.every((sql) => !sql.includes('target_skills')));
  });

  it('purges only old unreferenced skill snapshot blobs in bounded batches', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rowCount: 7, rows: [] };
    });

    const purged = await purgeOrphanedSkillSnapshotBlobs(0, 999999);

    assert.equal(purged, 7);
    assert.match(capturedSql, /NOT EXISTS \(\s+SELECT 1\s+FROM run_skill_snapshots s/s);
    assert.match(capturedSql, /b\.last_referenced_at < NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
    assert.deepEqual(capturedParams, [1, 5000]);
  });
});
