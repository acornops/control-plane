import { withTransaction } from './repository-transaction.js';

// Whole sessions preserve context shared by multiple executions. A terminal
// aggregate alone is insufficient: children, approvals and dispatch may be live.
const expired = `
  s.created_at < NOW()-($1::int*INTERVAL '1 day')
  AND EXISTS (SELECT 1 FROM workflow_executions e WHERE e.workflow_session_id=s.id)
  AND NOT EXISTS (SELECT 1 FROM workflow_executions e WHERE e.workflow_session_id=s.id
    AND (e.status NOT IN ('completed','failed','cancelled') OR e.ended_at IS NULL
      OR e.ended_at >= NOW()-($1::int*INTERVAL '1 day') OR e.updated_at >= NOW()-($1::int*INTERVAL '1 day')))
  AND NOT EXISTS (SELECT 1 FROM workflow_messages m WHERE m.session_id=s.id
    AND m.created_at >= NOW()-($1::int*INTERVAL '1 day'))
  AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_session_id=s.id
    AND (r.status NOT IN ('completed','failed','cancelled') OR r.ended_at IS NULL
      OR r.ended_at >= NOW()-($1::int*INTERVAL '1 day')
      OR EXISTS (SELECT 1 FROM workflow_run_approvals a WHERE a.run_id=r.id
        AND (a.status='pending' OR a.execution_status IN ('executing','unknown')
          OR (a.approval_kind='tool_write' AND a.status='approved' AND a.execution_status='not_started')))
      OR EXISTS (SELECT 1 FROM automation_dispatch_outbox d WHERE d.run_id=r.id
        AND d.status NOT IN ('delivered','cancelled'))
      OR EXISTS (SELECT 1 FROM workspace_run_reservations c WHERE c.run_id=r.id
        AND (c.state<>'settled' OR c.settled_at IS NULL))
      OR EXISTS (SELECT 1 FROM workspace_run_operations o WHERE o.run_id=r.id AND o.finished_at IS NULL)))`;

export async function purgeExpiredWorkflowHistory(retentionDays: number, limit = 50): Promise<number> {
  return withTransaction(async client => {
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='100ms'");
    const candidates = await client.query<{ id: string }>(
      `SELECT s.id FROM workflow_sessions s WHERE ${expired}
       ORDER BY s.created_at,s.id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      [retentionDays, Math.min(Math.max(limit, 1), 50)]);
    let purged = 0;
    const deadline = performance.now() + 5000;
    for (const { id } of candidates.rows) {
      if (performance.now() >= deadline) break;
      await client.query('SAVEPOINT workflow_history');
      try {
        // Retry locks execution before session. Never wait on children while
        // holding the session lock; roll back this candidate on contention.
        const runs = 'SELECT id FROM workflow_runs WHERE workflow_session_id=$1';
        for (const [table, predicate] of [
          ['workflow_executions', 'workflow_session_id=$1'],
          ['workflow_runs', 'workflow_session_id=$1'],
          ['workflow_messages', 'session_id=$1'],
          ['workflow_run_approvals', `run_id IN (${runs})`],
          ['automation_dispatch_outbox', `run_id IN (${runs})`],
          ['workspace_run_reservations', `run_id IN (${runs})`],
          ['workspace_run_operations', `run_id IN (${runs})`]
        ]) {
          await client.query(`SELECT 1 FROM ${table} WHERE ${predicate} FOR UPDATE NOWAIT`, [id]);
        }
        // A fresh READ COMMITTED snapshot observes writers that committed
        // between candidate selection and child locking.
        const eligible = await client.query(`SELECT 1 FROM workflow_sessions s WHERE s.id=$2 AND ${expired}`, [retentionDays, id]);
        if (eligible.rowCount) {
          await client.query(`DELETE FROM automation_dispatch_outbox WHERE run_id IN (${runs})`, [id]);
          await client.query(`DELETE FROM workspace_run_reservations WHERE run_id IN (${runs})`, [id]);
          // Remove message references before the session cascades its messages.
          await client.query('DELETE FROM workflow_executions WHERE workflow_session_id=$1', [id]);
          await client.query('DELETE FROM workflow_sessions WHERE id=$1', [id]);
          purged++;
        }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT workflow_history');
        if (!['55P03', '40P01', '57014'].includes((error as { code?: string }).code ?? '')) throw error;
      }
      await client.query('RELEASE SAVEPOINT workflow_history');
    }
    return purged;
  });
}
