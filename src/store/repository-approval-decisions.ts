import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';

export interface ApprovalDecisionRowOutcome {
  row: QueryResultRow;
  transitioned: boolean;
}

export async function decideAutomationApprovalRow(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<ApprovalDecisionRowOutcome | null> {
  const status = decision === 'approved' ? 'approved' : 'rejected';
  const result = await db.query<QueryResultRow & { transitioned: boolean }>(
    `WITH transitioned AS (
       UPDATE automation_run_approvals SET
         status=CASE WHEN expires_at<=NOW() THEN 'expired' ELSE $2 END,
         decision=CASE WHEN expires_at>NOW() THEN $3 ELSE decision END,
         decided_by=CASE WHEN expires_at>NOW() THEN $4 ELSE decided_by END,
         decided_at=CASE WHEN expires_at>NOW() THEN NOW() ELSE decided_at END
       WHERE id=$1 AND status='pending'
       RETURNING *, TRUE AS transitioned
     )
     SELECT * FROM transitioned
     UNION ALL
     SELECT existing.*, FALSE AS transitioned
     FROM automation_run_approvals existing
     WHERE existing.id=$1
       AND NOT EXISTS (SELECT 1 FROM transitioned)`,
    [approvalId, status, decision, decidedBy]
  );
  return result.rowCount ? { row: result.rows[0], transitioned: result.rows[0].transitioned } : null;
}

export async function decideWorkflowApprovalRow(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<ApprovalDecisionRowOutcome | null> {
  const result = await db.query<QueryResultRow & { transitioned: boolean }>(
    `WITH transitioned AS (
       UPDATE workflow_approvals SET
         status=CASE WHEN expires_at<=NOW() THEN 'expired' ELSE $2 END,
         decision=CASE WHEN expires_at<=NOW() THEN decision ELSE $2 END,
         decided_by=CASE WHEN expires_at<=NOW() THEN decided_by ELSE $3 END,
         decided_at=CASE WHEN expires_at<=NOW() THEN decided_at ELSE NOW() END
       WHERE id=$1 AND status='pending'
       RETURNING *, TRUE AS transitioned
     )
     SELECT * FROM transitioned
     UNION ALL
     SELECT existing.*, FALSE AS transitioned
     FROM workflow_approvals existing
     WHERE existing.id=$1
       AND NOT EXISTS (SELECT 1 FROM transitioned)`,
    [approvalId, decision, decidedBy]
  );
  return result.rowCount ? { row: result.rows[0], transitioned: result.rows[0].transitioned } : null;
}
