-- Bind cluster triage to the system-owned AcornOps Kubernetes MCP server and
-- the concrete tools discovered from AgentK. Existing migrations remain
-- immutable because their checksums may already be recorded in production.
CREATE OR REPLACE FUNCTION seed_workspace_cluster_triage_v2(target_workspace_id TEXT, owner_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_definitions (
    workspace_id, id, name, description, instructions, status, source, kind,
    provider_type, version, owner_user_id, created_by, mcp_servers, tools,
    skills, context_grants, target_scope, approval_policy, trust_policy,
    system_template_version, readiness_status, readiness_reasons
  ) VALUES (
    target_workspace_id, 'agent-cluster-triage', 'Kubernetes Diagnostics',
    'Collects live Kubernetes inventory, resource details, and logs through the built-in AgentK tool server.',
    'Use only the selected target and the read-only built-in AgentK tools. Cite observed evidence.',
    'active', 'system', 'specialist_agent', 'internal', 2, owner_id, 'system',
    '["acornops-target-agent"]', '["get_resource","get_resource_logs","list_resources"]',
    '["acornops-observability","acornops-target-boundary-design"]', '["target_inventory","workspace_metadata"]',
    '{"type":"selected_target","targetTypes":["kubernetes"]}',
    '{"mode":"none","writeToolsRequireApproval":true}', '{"level":"restricted","allowExternalData":false}',
    2, 'needs_setup', '["Select an online Kubernetes target with the built-in AcornOps Target Tools server."]'
  )
  ON CONFLICT (workspace_id, id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    instructions = EXCLUDED.instructions,
    version = EXCLUDED.version,
    mcp_servers = EXCLUDED.mcp_servers,
    tools = EXCLUDED.tools,
    skills = EXCLUDED.skills,
    context_grants = EXCLUDED.context_grants,
    target_scope = EXCLUDED.target_scope,
    approval_policy = EXCLUDED.approval_policy,
    trust_policy = EXCLUDED.trust_policy,
    system_template_version = EXCLUDED.system_template_version,
    readiness_status = EXCLUDED.readiness_status,
    readiness_reasons = EXCLUDED.readiness_reasons,
    updated_at = NOW()
  WHERE agent_definitions.source = 'system'
    AND COALESCE(agent_definitions.system_template_version, 0) < EXCLUDED.system_template_version;

  INSERT INTO workflow_definitions (
    workspace_id, id, version, source, template_id, name, description, status,
    category, orchestrator_agent_id, tags, inputs, enabled_mcp_servers,
    enabled_skills, required_permissions, policy, steps, starter_prompt,
    created_by, system_template_version, readiness_status, readiness_reasons
  ) VALUES (
    target_workspace_id, 'cluster-triage', 2, 'system', 'cluster-triage', 'Cluster triage',
    'Inspect a selected online Kubernetes target using the built-in AcornOps Kubernetes tools.',
    'active', 'cluster-triage', 'agent-workflow-orchestrator', '["cluster","triage","incident"]',
    '[{"name":"targetId","label":"Kubernetes cluster","type":"cluster","required":true,"optionSource":"clusters"}]',
    '["acornops-target-agent"]', '["acornops-observability","acornops-target-boundary-design"]',
    '["read_workspace_data","create_read_only_runs"]',
    '{"mode":"read_only","maxRuntimeSeconds":900,"retentionDays":90,"approvalRequirements":[]}',
    '[{"id":"collect-cluster-signals","title":"Collect cluster signals","requiredInputs":["targetId"],"agentIds":["agent-cluster-triage"],"targetBinding":{"type":"selected_target","targetType":"kubernetes","inputName":"targetId"},"enabledSkills":["acornops-observability","acornops-target-boundary-design"],"allowedMcpServers":["acornops-target-agent"],"allowedTools":["get_resource","get_resource_logs","list_resources"],"contextGrants":["workspace_metadata","target_inventory"],"approvalRequired":false}]',
    'Triage the selected Kubernetes cluster using live built-in inventory, resource, and log evidence.',
    'system', 2, 'needs_setup',
    '["Select an online Kubernetes target with the built-in AcornOps Target Tools server."]'
  )
  ON CONFLICT (workspace_id, id) DO UPDATE SET
    version = EXCLUDED.version,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    inputs = EXCLUDED.inputs,
    enabled_mcp_servers = EXCLUDED.enabled_mcp_servers,
    enabled_skills = EXCLUDED.enabled_skills,
    required_permissions = EXCLUDED.required_permissions,
    policy = EXCLUDED.policy,
    steps = EXCLUDED.steps,
    starter_prompt = EXCLUDED.starter_prompt,
    system_template_version = EXCLUDED.system_template_version,
    readiness_status = EXCLUDED.readiness_status,
    readiness_reasons = EXCLUDED.readiness_reasons,
    updated_at = NOW()
  WHERE workflow_definitions.source = 'system'
    AND COALESCE(workflow_definitions.system_template_version, 0) < EXCLUDED.system_template_version;

  UPDATE agent_definitions
  SET version = 2,
      mcp_servers = '[]'::jsonb,
      tools = '["chat.sessions.read_selected","reports.pdf.generate"]'::jsonb,
      system_template_version = 2,
      readiness_status = 'ready',
      readiness_reasons = '[]'::jsonb,
      updated_at = NOW()
  WHERE workspace_id = target_workspace_id
    AND source = 'system'
    AND id = 'agent-incident-reporter'
    AND COALESCE(system_template_version, 0) < 2;

  UPDATE agent_definitions
  SET version = 2,
      mcp_servers = '[]'::jsonb,
      tools = '[]'::jsonb,
      system_template_version = 2,
      readiness_status = 'needs_setup',
      readiness_reasons = '["Add and assign a GitHub or GitLab MCP integration."]'::jsonb,
      updated_at = NOW()
  WHERE workspace_id = target_workspace_id
    AND source = 'system'
    AND id = 'agent-release-coordinator'
    AND COALESCE(system_template_version, 0) < 2;

  -- Repository automation remains visible but cannot launch until a user adds
  -- and assigns a real GitHub or GitLab MCP integration.
  UPDATE workflow_definitions
  SET status = 'paused',
      enabled_mcp_servers = '[]'::jsonb,
      steps = '[{"id":"inspect-repository-state","title":"Inspect repository state","requiredInputs":["repository","base"],"agentIds":["agent-release-coordinator"],"enabledSkills":["acornops-cross-repo-change"],"allowedMcpServers":[],"allowedTools":[],"contextGrants":["workspace_metadata"],"approvalRequired":false,"outputArtifacts":[{"id":"change-plan","type":"task_list","title":"Exact repository change plan","required":true}]},{"id":"apply-repository-change","title":"Apply approved repository change","requiredInputs":["repository","base","branch"],"agentIds":["agent-release-coordinator"],"enabledSkills":["acornops-open-pr"],"allowedMcpServers":[],"allowedTools":[],"contextGrants":["workspace_metadata"],"approvalRequired":true,"outputArtifacts":[{"id":"change-request","type":"task_list","title":"Draft change request","required":true}]}]'::jsonb,
      system_template_version = 2,
      readiness_status = 'needs_setup',
      readiness_reasons = '["Add and assign a GitHub or GitLab MCP integration."]'::jsonb,
      updated_at = NOW()
  WHERE workspace_id = target_workspace_id
    AND source = 'system'
    AND id = 'repository-operation'
    AND COALESCE(system_template_version, 0) < 2;

  UPDATE workflow_definitions
  SET version = 2,
      status = 'active',
      inputs = '[{"name":"chatSessionIds","label":"Incident chats","type":"chat_session_list","required":true,"optionSource":"chatSessions"}]'::jsonb,
      enabled_mcp_servers = '[]'::jsonb,
      steps = '[{"id":"generate-incident-report","title":"Generate incident report","requiredInputs":["chatSessionIds"],"agentIds":["agent-incident-reporter"],"enabledSkills":["acornops-observability"],"allowedMcpServers":[],"allowedTools":["chat.sessions.read_selected","reports.pdf.generate"],"contextGrants":["selected_chat_sessions"],"approvalRequired":true,"outputArtifacts":[{"id":"incident-report","type":"pdf","title":"Incident report PDF","required":true}]}]'::jsonb,
      system_template_version = 2,
      readiness_status = 'ready',
      readiness_reasons = '[]'::jsonb,
      updated_at = NOW()
  WHERE workspace_id = target_workspace_id
    AND source = 'system'
    AND id = 'incident-report-pdf'
    AND COALESCE(system_template_version, 0) < 2;
END $$;

SELECT seed_workspace_cluster_triage_v2(id, created_by) FROM workspaces;

CREATE OR REPLACE FUNCTION seed_workspace_cluster_triage_v2_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_workspace_cluster_triage_v2(NEW.id, NEW.created_by);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workspaces_seed_cluster_triage_v2 ON workspaces;
CREATE TRIGGER workspaces_seed_cluster_triage_v2
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION seed_workspace_cluster_triage_v2_trigger();
