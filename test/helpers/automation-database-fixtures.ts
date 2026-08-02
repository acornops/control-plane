import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import { db } from '../../src/infra/db.js';

function assertIsolatedTestDatabase(): void {
  const explicitTestUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
  assert.equal(process.env.NODE_ENV, 'test', 'automation database fixtures require NODE_ENV=test');
  assert.ok(explicitTestUrl, 'automation database fixtures require CONTROL_PLANE_TEST_DATABASE_URL');
  assert.equal(config.DATABASE_URL, explicitTestUrl, 'DATABASE_URL must match CONTROL_PLANE_TEST_DATABASE_URL');

  const databaseName = new URL(explicitTestUrl).pathname.replace(/^\//, '');
  assert.match(databaseName, /(?:^|[_-])test(?:$|[_-])/, 'automation fixtures require an explicitly named test database');
}

export async function resetAutomationDatabaseFixtures(): Promise<void> {
  assertIsolatedTestDatabase();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE TABLE
         workspace_membership_audit,
         workspace_audit_events,
         workspace_memberships,
         workspaces
       CASCADE`
    );
    await client.query(
      `INSERT INTO users (id,email,display_name)
       VALUES ('user-1','user-1@example.test','Test User')
       ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name`
    );
    await client.query(
      `INSERT INTO workspaces (id,name,created_by)
       VALUES ('workspace-1','Test Workspace','user-1'),('workspace-2','Other Test Workspace','user-1')`
    );
    await client.query(
      `INSERT INTO targets (id,workspace_id,target_type,name,status,metadata,created_at,updated_at)
       VALUES
         ('cluster-1','workspace-1','kubernetes','Test Cluster','online','{}',now(),now()),
         ('cluster-2','workspace-2','kubernetes','Other Test Cluster','online','{}',now(),now())`
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function installAutomationTemplateFixtures(
  workspaceIds: string[] = ['workspace-1', 'workspace-2']
): Promise<void> {
  assertIsolatedTestDatabase();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const workspaceId of workspaceIds) {
      await client.query(
        `INSERT INTO agent_definitions (
           workspace_id,id,name,avatar_emoji,description,instructions,status,provider_type,owner_user_id,created_by,
           mcp_servers,tools,skills,approval_policy,trust_policy,mcp_tools,mcp_installations,
           permission_mode,skill_installations,review_state,semantic_capability_ids,
           readiness_status,readiness_reasons
         ) VALUES
         ($1,'agent-cluster-triage','Infrastructure Diagnostics','🔎','Collects infrastructure diagnostic evidence.','Use only the environment identified by the request when calling relevant MCP tools.','active','internal','user-1','user-1',
          '[]','[]','[]',
          '{"mode":"before_write","writeToolsRequireApproval":true}','{"level":"restricted","allowExternalData":false}',
          '[]','[]','read_only','[]','reviewed','["infrastructure.diagnostics.read"]','ready','[]'),
         ($1,'agent-incident-reporter','Incident Reporter','📝','Creates evidence-backed incident reports.','Use only explicitly granted evidence.','active','internal','user-1','user-1',
          '[]','["documents.create"]','[]',
          '{"mode":"before_write","writeToolsRequireApproval":true}','{"level":"restricted","allowExternalData":false}',
          '[]','[]','read_only','[]','reviewed','["incident.report.generate"]','ready','[]')`,
        [workspaceId]
      );
      await client.query(
        `INSERT INTO capability_routing_mappings (
           workspace_id,id,capability_id,agent_id,status,review_state,priority,
           mcp_tools,native_tool_ids,skill_ids,created_by,reviewed_by
         ) VALUES
         ($1,'route-target-diagnostics','infrastructure.diagnostics.read','agent-cluster-triage','active','reviewed',10,
          '[]',
          '[]','[]','user-1','user-1'),
         ($1,'route-incident-report','incident.report.generate','agent-incident-reporter','active','reviewed',10,
          '[]','["documents.create"]','[]','user-1','user-1')`,
        [workspaceId]
      );
      await client.query(
         `INSERT INTO workflow_definitions (
           workspace_id,id,name,description,status,tags,created_by,
           readiness_status,readiness_reasons,prompt,agent_ids
         ) VALUES
         ($1,'cluster-triage','Infrastructure diagnostics','Inspect one explicitly identified environment.','active','["diagnostics"]','user-1',
          'ready','[]',
          'Inspect the infrastructure named in the request and summarize findings.','["agent-cluster-triage"]'),
         ($1,'incident-report-pdf','Incident report','Generate a report from selected chats.','active','["incident"]',
          'user-1','ready','[]',
          'Generate an incident report from the incident context named in the request with provenance.','["agent-incident-reporter"]')`,
        [workspaceId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAutomationDatabaseFixtures(): Promise<void> {
  await db.end();
}
