-- Seed system-owned Workflow skills transactionally with workspace creation and
-- backfill existing workspaces. Catalog reads must remain read-only.

CREATE OR REPLACE FUNCTION seed_workspace_system_skills(target_workspace_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_skills (
    workspace_id,id,name,description,source,enabled,validation_status
  ) VALUES
    (target_workspace_id,'acornops-observability','AcornOps observability','Incident and signal analysis','system',true,'valid'),
    (target_workspace_id,'acornops-cross-repo-change','Cross-repo change','Multi-repository coordination','system',true,'valid'),
    (target_workspace_id,'acornops-open-pr','Open PR','Prepare branch and pull request handoff','system',true,'valid'),
    (target_workspace_id,'acornops-target-boundary-design','Target boundary design','Target model compatibility checks','system',true,'valid')
  ON CONFLICT DO NOTHING;
END $$;

SELECT seed_workspace_system_skills(id) FROM workspaces;

CREATE OR REPLACE FUNCTION seed_workspace_system_skills_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_workspace_system_skills(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workspaces_seed_system_skills ON workspaces;
CREATE TRIGGER workspaces_seed_system_skills
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION seed_workspace_system_skills_trigger();
