ALTER TABLE workspace_policy_receipts ADD COLUMN admin_token_id text NOT NULL DEFAULT '__legacy_unattributed__';
ALTER TABLE workspace_policy_receipts ADD COLUMN operation text NOT NULL DEFAULT 'plan'
  CHECK (operation IN ('plan','quotas','suspend','restore'));
-- The 007 writer stored policyRequestId in its authoritative success audit.
-- Preserve unattributable receipts in an unreachable legacy credential namespace.
UPDATE workspace_policy_receipts receipt
SET (admin_token_id, operation) = (
  SELECT audit.admin_token_id,
    CASE audit.action WHEN 'admin.workspace.plan.update' THEN 'plan'
      WHEN 'admin.workspace.quotas.update' THEN 'quotas'
      WHEN 'admin.workspace.suspend' THEN 'suspend' ELSE 'restore' END
  FROM admin_audit_events audit
  WHERE audit.workspace_id=receipt.workspace_id AND audit.outcome='success'
    AND audit.admin_token_id IS NOT NULL
    AND audit.metadata->>'policyRequestId'=receipt.request_id
    AND audit.action IN ('admin.workspace.plan.update','admin.workspace.quotas.update','admin.workspace.suspend','admin.workspace.restore')
  ORDER BY audit.occurred_at DESC LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM admin_audit_events audit WHERE audit.workspace_id=receipt.workspace_id
    AND audit.outcome='success' AND audit.admin_token_id IS NOT NULL
    AND audit.metadata->>'policyRequestId'=receipt.request_id
    AND audit.action IN ('admin.workspace.plan.update','admin.workspace.quotas.update','admin.workspace.suspend','admin.workspace.restore')
);
ALTER TABLE workspace_policy_receipts DROP CONSTRAINT workspace_policy_receipts_pkey;
ALTER TABLE workspace_policy_receipts ADD PRIMARY KEY (admin_token_id, workspace_id, operation, request_id);
ALTER TABLE workspace_policy_receipts ALTER COLUMN admin_token_id DROP DEFAULT;
ALTER TABLE workspace_policy_receipts ALTER COLUMN operation DROP DEFAULT;
CREATE INDEX workspace_policy_receipts_expiry ON workspace_policy_receipts(created_at);
UPDATE workspace_suspension_holds SET public_reason='Workspace access is temporarily suspended by an administrator.'
WHERE source='admin' AND public_reason IS NULL;
