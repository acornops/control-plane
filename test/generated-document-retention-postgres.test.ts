import assert from 'node:assert/strict';
import { after, beforeEach, it } from 'node:test';
import { db } from '../src/infra/db.js';
import * as documents from '../src/store/repository-generated-documents.js';
import { coordinatedRoot } from './helpers/workflow-delegation-postgres-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

let workflowRunId: string;
let executionId: string;
beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  const { parent } = await coordinatedRoot();
  workflowRunId = parent.id;
  executionId = parent.executionId;
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
    VALUES('document-session','workspace-1','cluster-1','user-1','Documents','open',NOW(),NOW())`);
  await db.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
    VALUES('document-run','workspace-1','cluster-1','document-session','message-1','completed',NOW())`);
});
after(closeAutomationDatabaseFixtures);

async function insertDocuments(prefix: string, scope: 'workflow' | 'conversation', count: number, expiry = '-1 day') {
  await db.query(
    `INSERT INTO generated_documents (
       id,workspace_id,workflow_execution_id,workflow_run_id,conversation_run_id,
       title,source,provenance,source_size_bytes,retention_expires_at
     ) SELECT $1 || n,'workspace-1',$2,$3,$4,'Report','{"markdown":"evidence"}','{}',23,
         NOW() + $5::interval FROM generate_series(1,$6::int) n`,
    [prefix, scope === 'workflow' ? executionId : null, scope === 'workflow' ? workflowRunId : null,
      scope === 'conversation' ? 'document-run' : null, expiry, count]
  );
}

it('purges expired documents in both scopes while preserving unexpired documents and every parent', async () => {
  await insertDocuments('expired-workflow-', 'workflow', 1);
  await insertDocuments('expired-conversation-', 'conversation', 1);
  await insertDocuments('boundary-', 'workflow', 1, '0 seconds');
  await insertDocuments('keep-workflow-', 'workflow', 1, '1 day');
  await insertDocuments('keep-conversation-', 'conversation', 1, '1 day');
  const before = (await db.query('SELECT * FROM generated_documents WHERE id LIKE \'keep-%\' ORDER BY id')).rows;
  const parents = await Promise.all([
    db.query('SELECT * FROM workflow_runs WHERE id=$1', [workflowRunId]),
    db.query('SELECT * FROM workflow_executions WHERE id=$1', [executionId]),
    db.query('SELECT * FROM runs WHERE id=\'document-run\''),
    db.query('SELECT * FROM sessions WHERE id=\'document-session\'')
  ]);
  assert.equal(await documents.getGeneratedDocument('boundary-1'), null);
  assert.equal(await documents.purgeExpiredGeneratedDocuments(), 3);
  assert.deepEqual((await db.query('SELECT * FROM generated_documents ORDER BY id')).rows, before);
  const afterParents = await Promise.all([
    db.query('SELECT * FROM workflow_runs WHERE id=$1', [workflowRunId]),
    db.query('SELECT * FROM workflow_executions WHERE id=$1', [executionId]),
    db.query('SELECT * FROM runs WHERE id=\'document-run\''),
    db.query('SELECT * FROM sessions WHERE id=\'document-session\'')
  ]);
  assert.deepEqual(afterParents.map(result => result.rows), parents.map(result => result.rows));
  assert.equal(await documents.purgeExpiredGeneratedDocuments(), 0);
});

it('caps each deletion at 500 rows and supports concurrent cleanup', async () => {
  await insertDocuments('expired-', 'workflow', 1_201);
  const deleted = await Promise.all([
    documents.purgeExpiredGeneratedDocuments(10_000), documents.purgeExpiredGeneratedDocuments(10_000)
  ]);
  assert.deepEqual(deleted, [500, 500]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM generated_documents')).rows[0].count, 201);
  assert.equal(await documents.purgeExpiredGeneratedDocuments(1), 1);
  assert.equal(await documents.purgeExpiredGeneratedDocuments(), 200);
});

it('skips locked documents and resumes their cleanup after the writer releases them', async () => {
  await insertDocuments('locked-', 'workflow', 1);
  await insertDocuments('available-', 'conversation', 1);
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    await writer.query("SELECT id FROM generated_documents WHERE id='locked-1' FOR UPDATE");
    assert.equal(await documents.purgeExpiredGeneratedDocuments(), 1);
    assert.deepEqual((await db.query('SELECT id FROM generated_documents')).rows, [{ id: 'locked-1' }]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  assert.equal(await documents.purgeExpiredGeneratedDocuments(), 1);
});
