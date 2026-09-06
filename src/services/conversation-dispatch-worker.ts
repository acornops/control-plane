import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { repo } from '../store/repository.js';
import { assertExecutionActive } from './workspace-execution-access.js';
import { dispatchRunToExecutionEngine } from './execution-engine-client.js';

const owner = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
let running = false;
export async function runConversationDispatchTick(): Promise<void> {
  if (!config.WORKSPACE_DISPATCH_ENABLED) return;
  if (running) return;
  running = true;
  try {
    const claims = await db.query<{ id: string; run_id: string; attempt_count: number }>(`WITH candidates AS (
      SELECT o.id FROM automation_dispatch_outbox o JOIN runs r ON r.id=o.run_id
      WHERE o.source_type='conversation' AND (o.status IN ('pending','failed') OR (o.status='claimed' AND o.claim_expires_at<NOW()))
      AND o.next_attempt_at<=NOW() AND r.status IN ('queued','dispatching')
      ORDER BY o.created_at,o.id LIMIT 25 FOR UPDATE OF o SKIP LOCKED)
      UPDATE automation_dispatch_outbox o SET status='claimed',claim_owner=$1,claim_expires_at=NOW()+INTERVAL '1 minute'
      FROM candidates c WHERE o.id=c.id RETURNING o.id,o.run_id,o.attempt_count`, [owner]);
    for (const claim of claims.rows) {
      try {
        await assertExecutionActive(claim.run_id);
        const run = await repo.getRun(claim.run_id);
        if (!run || !['queued', 'dispatching'].includes(run.status)) {
          await db.query(`UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL
            WHERE id=$1 AND claim_owner=$2 AND status='claimed'`, [claim.id, owner]);
          continue;
        }
        await dispatchRunToExecutionEngine(run);
        await db.query(`UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW(),claim_owner=NULL,claim_expires_at=NULL
          WHERE id=$1 AND claim_owner=$2 AND status='claimed'`, [claim.id, owner]);
      } catch (error) {
        await db.query(`UPDATE automation_dispatch_outbox SET status='failed',attempt_count=attempt_count+1,
          next_attempt_at=NOW()+INTERVAL '10 seconds',claim_owner=NULL,claim_expires_at=NULL,
          last_error_code='DISPATCH_FAILED',last_error_message='Delivery deferred'
          WHERE id=$1 AND claim_owner=$2 AND status='claimed'`, [claim.id, owner]);
        logger.warn({ err: error, runId: claim.run_id }, 'Conversation dispatch deferred');
      }
    }
  } finally { running = false; }
}
