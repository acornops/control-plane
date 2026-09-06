/** Loopback-only replica fixture: real HTTP authority routes and PostgreSQL admissions. */
import express from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/infra/db.js';
import { withTransaction } from '../../src/store/repository-transaction.js';
import { reserveRunCapacity, settleRunCapacity, WorkspaceCapacityError } from '../../src/store/repository-run-capacity.js';

if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL !== process.env.CONTROL_PLANE_TEST_DATABASE_URL) throw new Error('Isolated test database required');
const app = express();
app.use(express.json());
app.post('/fixture/admit', async (req, res) => {
  try {
    await withTransaction(async client => {
      await reserveRunCapacity(client, req.body);
      await client.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
        VALUES($1,$2,'cluster-1','replica-session',$1,'queued',clock_timestamp())`, [req.body.runId, req.body.workspaceId]);
    });
    res.status(201).json({ runId: req.body.runId });
  } catch (error) {
    res.status(error instanceof WorkspaceCapacityError ? error.status : 500).json({ code: error instanceof WorkspaceCapacityError ? error.code : 'FIXTURE_ERROR' });
  }
});
app.use(createApp());
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ port: typeof address === 'object' ? address?.port : null }));
});
const timer = setInterval(async () => {
  const rows = await db.query("SELECT run_id FROM workspace_run_reservations WHERE state='settling' AND settled_at IS NULL");
  for (const row of rows.rows) await settleRunCapacity(row.run_id);
}, 100);
process.on('SIGTERM', () => { clearInterval(timer); server.close(); void db.end().then(() => process.exit()); });
