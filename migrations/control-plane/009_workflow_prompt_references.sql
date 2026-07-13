-- Make built-in workflow launch targeting prompt-first. The input values remain
-- structured authorization bindings, but operators choose resources by inserting
-- explicit mentions into the control message.
CREATE OR REPLACE FUNCTION seed_workspace_workflow_prompt_references_v3(target_workspace_id TEXT, owner_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Ensure the v2 tool bindings exist for workspaces created while this migration
  -- is current, regardless of trigger execution order.
  PERFORM seed_workspace_cluster_triage_v2(target_workspace_id, owner_id);

  UPDATE workflow_definitions
  SET version = 3,
      description = 'Mention a Kubernetes cluster in the control message and inspect it using the built-in AcornOps Kubernetes tools.',
      starter_prompt = 'Triage @cluster[Cluster name] using live built-in inventory, resource, and log evidence.',
      system_template_version = 3,
      updated_at = NOW()
  WHERE workspace_id = target_workspace_id
    AND source = 'system'
    AND id = 'cluster-triage'
    AND COALESCE(system_template_version, 0) < 3;

  UPDATE workflow_definitions
  SET version = 3,
      description = 'Mention one or more incident chats in the control message and generate a PDF incident report artifact.',
      starter_prompt = 'Generate a PDF incident report from @chat[Incident chat title].',
      system_template_version = 3,
      updated_at = NOW()
  WHERE workspace_id = target_workspace_id
    AND source = 'system'
    AND id = 'incident-report-pdf'
    AND COALESCE(system_template_version, 0) < 3;
END $$;

SELECT seed_workspace_workflow_prompt_references_v3(id, created_by) FROM workspaces;

CREATE OR REPLACE FUNCTION seed_workspace_workflow_prompt_references_v3_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_workspace_workflow_prompt_references_v3(NEW.id, NEW.created_by);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workspaces_seed_workflow_prompt_references_v3 ON workspaces;
CREATE TRIGGER workspaces_seed_workflow_prompt_references_v3
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION seed_workspace_workflow_prompt_references_v3_trigger();
