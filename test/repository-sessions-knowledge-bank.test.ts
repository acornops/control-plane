import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { logger } from '../src/logger.js';
import { upsertAssistantFinalMessage } from '../src/store/repository-sessions.js';

afterEach(() => {
  mock.restoreAll();
});

describe('session repository Knowledge Bank scheduling', () => {
  it('contains checkpoint enqueue failures inside a transaction savepoint', async () => {
    const queries: string[] = [];
    let released = false;
    const messageRow = {
      id: 'message-1',
      session_id: 'session-1',
      run_id: 'run-1',
      role: 'assistant',
      kind: 'assistant_final',
      content: 'Final answer',
      metadata: null,
      client_message_id: null,
      created_at: '2026-06-29T01:00:00.000Z'
    };
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: null, rows: [] };
        }
        if (sql === 'SAVEPOINT knowledge_bank_checkpoint_enqueue' ||
          sql === 'ROLLBACK TO SAVEPOINT knowledge_bank_checkpoint_enqueue' ||
          sql === 'RELEASE SAVEPOINT knowledge_bank_checkpoint_enqueue') {
          return { rowCount: null, rows: [] };
        }
        if (sql.includes('FROM messages') && sql.includes('FOR UPDATE')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('INSERT INTO messages')) {
          return { rowCount: 1, rows: [messageRow] };
        }
        if (sql.includes('UPDATE sessions')) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('SELECT s.workspace_id')) {
          return {
            rowCount: 1,
            rows: [{
              workspace_id: 'workspace-1',
              target_id: 'target-1',
              target_type: 'kubernetes',
              tool_enabled: true,
              config_json: null
            }]
          };
        }
        if (sql.includes('INSERT INTO target_knowledge_checkpoint_jobs')) {
          throw new Error('checkpoint queue unavailable');
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => {
        released = true;
      }
    };
    const warn = mock.method(logger, 'warn', () => undefined);
    mock.method(db, 'connect', async () => client);

    const message = await upsertAssistantFinalMessage('session-1', 'run-1', 'Final answer');

    assert.equal(message.id, 'message-1');
    assert.equal(released, true);
    assert.equal(queries.includes('ROLLBACK TO SAVEPOINT knowledge_bank_checkpoint_enqueue'), true);
    assert.equal(queries.includes('COMMIT'), true);
    assert.equal(queries.includes('ROLLBACK'), false);
    assert.equal(warn.mock.callCount(), 1);
  });
});
