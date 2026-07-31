-- Retire AcornOps event triggers while retaining workflow execution and audit
-- history. Signed webhook configuration and queued deliveries are renamed in
-- place so secrets, replay identifiers, and dispatch pointers survive.

DELETE FROM automation_trigger_deliveries delivery
USING workflow_event_triggers trigger
WHERE delivery.trigger_id = trigger.id
  AND trigger.source_type = 'acornops_event';

DELETE FROM automation_trigger_events
WHERE source_type = 'issue';

DELETE FROM workflow_event_triggers
WHERE source_type = 'acornops_event';

UPDATE workflow_executions
SET origin_snapshot = CASE
  WHEN origin_snapshot->'source'->>'kind' = 'webhook' THEN jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'webhook',
    'label', COALESCE(origin_snapshot->>'label', 'Workflow webhook'),
    'webhookId', COALESCE(origin_snapshot->>'triggerId', trigger_id)
  )
  ELSE jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'historical_event',
    'label', COALESCE(origin_snapshot->>'label', 'Historical workflow event')
  )
END
WHERE origin_snapshot->>'kind' = 'event_trigger';

UPDATE workflow_executions
SET origin_snapshot = (origin_snapshot - 'triggerId')
  || jsonb_build_object('scheduleId', COALESCE(origin_snapshot->>'triggerId', trigger_id))
WHERE origin_snapshot->>'kind' = 'schedule';

ALTER TABLE workflow_event_triggers
  DROP CONSTRAINT workflow_event_triggers_event_type_check,
  DROP CONSTRAINT workflow_event_triggers_input_bindings_check,
  DROP CONSTRAINT workflow_event_triggers_source_secret_check,
  DROP CONSTRAINT workflow_event_triggers_source_type_check;

DROP INDEX workflow_event_triggers_issue_event_idx;

ALTER TABLE workflow_event_triggers
  DROP COLUMN source_type,
  DROP COLUMN event_type,
  DROP COLUMN input_bindings,
  ALTER COLUMN secret_ciphertext SET NOT NULL,
  ALTER COLUMN secret_key_id SET NOT NULL;

ALTER TABLE workflow_event_triggers RENAME COLUMN last_triggered_at TO last_received_at;
ALTER TABLE workflow_event_triggers RENAME TO workflow_webhooks;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_pkey TO workflow_webhooks_pkey;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_approved_context_grants_check TO workflow_webhooks_approved_context_grants_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_created_by_check TO workflow_webhooks_created_by_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_last_status_check TO workflow_webhooks_last_status_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_parameter_signature_check TO workflow_webhooks_parameter_signature_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_principal_check TO workflow_webhooks_principal_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_status_check TO workflow_webhooks_status_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_updated_by_check TO workflow_webhooks_updated_by_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_workflow_version_check TO workflow_webhooks_workflow_version_check;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_workspace_id_fkey TO workflow_webhooks_workspace_id_fkey;
ALTER TABLE workflow_webhooks RENAME CONSTRAINT workflow_event_triggers_workspace_id_workflow_id_fkey TO workflow_webhooks_workspace_id_workflow_id_fkey;
ALTER INDEX workflow_event_triggers_workspace_idx RENAME TO workflow_webhooks_workspace_idx;

ALTER TABLE automation_trigger_events
  DROP CONSTRAINT automation_trigger_events_workspace_id_source_type_source_i_key;
ALTER TABLE automation_trigger_events RENAME COLUMN source_id TO webhook_id;
ALTER TABLE automation_trigger_events
  DROP COLUMN event_type,
  DROP COLUMN source_type;
ALTER TABLE automation_trigger_events RENAME TO workflow_webhook_events;
ALTER TABLE workflow_webhook_events RENAME CONSTRAINT automation_trigger_events_pkey TO workflow_webhook_events_pkey;
ALTER TABLE workflow_webhook_events RENAME CONSTRAINT automation_trigger_events_payload_check TO workflow_webhook_events_payload_check;
ALTER TABLE workflow_webhook_events RENAME CONSTRAINT automation_trigger_events_workspace_id_fkey TO workflow_webhook_events_workspace_id_fkey;
ALTER TABLE workflow_webhook_events
  ADD CONSTRAINT workflow_webhook_events_workspace_webhook_occurrence_key
    UNIQUE (workspace_id, webhook_id, occurrence_key),
  ADD CONSTRAINT workflow_webhook_events_webhook_id_fkey
    FOREIGN KEY (webhook_id) REFERENCES workflow_webhooks(id) ON DELETE CASCADE;

ALTER TABLE automation_trigger_deliveries RENAME COLUMN trigger_id TO webhook_id;
ALTER TABLE automation_trigger_deliveries RENAME TO workflow_webhook_deliveries;
ALTER TABLE workflow_webhook_deliveries RENAME CONSTRAINT automation_trigger_deliveries_pkey TO workflow_webhook_deliveries_pkey;
ALTER TABLE workflow_webhook_deliveries RENAME CONSTRAINT automation_trigger_deliveries_event_id_trigger_id_key TO workflow_webhook_deliveries_event_id_webhook_id_key;
ALTER TABLE workflow_webhook_deliveries RENAME CONSTRAINT automation_trigger_deliveries_status_check TO workflow_webhook_deliveries_status_check;
ALTER TABLE workflow_webhook_deliveries RENAME CONSTRAINT automation_trigger_deliveries_event_id_fkey TO workflow_webhook_deliveries_event_id_fkey;
ALTER TABLE workflow_webhook_deliveries RENAME CONSTRAINT automation_trigger_deliveries_workspace_id_fkey TO workflow_webhook_deliveries_workspace_id_fkey;
ALTER TABLE workflow_webhook_deliveries
  ADD CONSTRAINT workflow_webhook_deliveries_webhook_id_fkey
    FOREIGN KEY (webhook_id) REFERENCES workflow_webhooks(id) ON DELETE CASCADE;
ALTER INDEX automation_trigger_deliveries_claim_idx RENAME TO workflow_webhook_deliveries_claim_idx;
