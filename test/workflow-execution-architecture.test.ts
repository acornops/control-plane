import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const schema = readFileSync(
  new URL('../migrations/control-plane/001_initial_schema.sql', import.meta.url),
  'utf8'
);
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const internalRoutes = readFileSync(new URL('../src/routes/internal-execution.ts', import.meta.url), 'utf8');
const executionController = readFileSync(
  new URL('../src/controllers/workflow-executions-controller.ts', import.meta.url),
  'utf8'
);
const agentSchemas = readFileSync(
  new URL('../src/docs/openapi/schema-components-agents.ts', import.meta.url),
  'utf8'
);
const workflowSchemas = readFileSync(
  new URL('../src/docs/openapi/schema-components-workflows.ts', import.meta.url),
  'utf8'
);
const executionClient = readFileSync(
  new URL('../src/services/execution-engine-client.ts', import.meta.url),
  'utf8'
);
const agentBootstrap = readFileSync(
  new URL('../src/controllers/internal-agent-chat-bootstrap.ts', import.meta.url),
  'utf8'
);
const workflowBootstrap = readFileSync(
  new URL('../src/controllers/internal-execution-bootstrap.ts', import.meta.url),
  'utf8'
);
const agentConversationController = readFileSync(
  new URL('../src/controllers/agent-conversations-controller.ts', import.meta.url),
  'utf8'
);
const agentConversationRepository = readFileSync(
  new URL('../src/store/repository-agent-conversations.ts', import.meta.url),
  'utf8'
);
const targetToolSync = readFileSync(
  new URL('../src/services/target-built-in-tool-sync.ts', import.meta.url),
  'utf8'
);
const workspaceMcpSpecs = readFileSync(
  new URL('../src/services/workspace-mcp-tool-specs.ts', import.meta.url),
  'utf8'
);

function tableBody(name: string): string {
  return schema.match(new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`))?.[1] || '';
}

describe('unified Workflow execution architecture', () => {
  it('models coordinator roots and specialist roots or children in workflow_runs', () => {
    for (const fragment of [
      'executor_role',
      'parent_run_id',
      'delegation_call_id',
      'delegation_capability_id',
      'delegation_required',
      'executor_snapshot',
      'workflow_runs_delegation_call_unique',
      'workflow_messages_one_assistant_per_run_idx'
    ]) {
      assert.equal(schema.includes(fragment), true, `missing schema invariant: ${fragment}`);
    }
    assert.match(schema, /executor_role = ANY \(ARRAY\['coordinator'::text, 'specialist'::text\]\)/);
    assert.match(schema, /source_type = 'workflow'::text/);
  });

  it('contains none of the removed Agent-run or Manager-Agent schema', () => {
    for (const removed of [
      'agent_activity',
      'agent_run_events',
      'agent_triggers',
      'workflow_delegations',
      'entry_agent_id',
      'delegate_agent_ids',
      'system_role',
      'delegation_policy',
      'invocation_scopes'
    ]) {
      assert.equal(schema.includes(removed), false, `removed schema identifier remains: ${removed}`);
    }
    assert.doesNotMatch(schema, /workflow_runs[\s\S]*?events jsonb/);
    const agentTable = schema.match(/CREATE TABLE agent_definitions \(([\s\S]*?)\n\);/)?.[1] || '';
    assert.doesNotMatch(agentTable, /\bkind text\b/);
  });

  it('exposes only role-aware generic Workflow internal run routes', () => {
    assert.equal(server.includes('internal-agent-bootstrap'), false);
    assert.equal(internalRoutes.includes('/agent-runs/'), false);
    assert.equal(internalRoutes.includes('/workflow-sessions/:sessionId/context'), false);
    assert.equal(internalRoutes.includes("'/runs/:runId/context'"), true);
    assert.equal(internalRoutes.includes("'/runs/:runId/skills/:skillRef'"), true);
    assert.equal(internalRoutes.includes("'/runs/:runId/delegations'"), true);
  });

  it('publishes Agents as specialist profiles without execution-role remnants', () => {
    assert.equal(agentSchemas.includes("kind: { type: 'string', enum: ['specialist'] }"), false);
    assert.equal(agentSchemas.includes('activity: jsonObject'), false);
    assert.equal(agentSchemas.includes('workflowUsage:'), false);
  });

  it('keeps Agent and Workflow persistence and wire payloads free of target bindings and definition versions', () => {
    for (const table of [
      'agent_definitions',
      'workflow_definitions',
      'workflow_sessions',
      'workflow_executions',
      'workflow_runs',
      'workflow_schedules'
    ]) {
      const body = tableBody(table);
      assert.notEqual(body, '', `missing table ${table}`);
      assert.doesNotMatch(
        body,
        /\btarget_(?:id|ids|type|name|scope|ref|binding|constraint|tool)/,
        `${table} contains target identity or binding`
      );
      assert.doesNotMatch(body, /\b(?:agent|workflow)_version\b/, `${table} contains definition versioning`);
    }
    assert.doesNotMatch(tableBody('agent_definitions'), /\borigin\b/, 'Agent definitions contain retired origin metadata');
    assert.doesNotMatch(
      tableBody('workflow_definitions'),
      /\b(?:origin|template_id|starter_prompt)\b/,
      'Workflow definitions contain retired template metadata'
    );
    assert.doesNotMatch(tableBody('agent_definitions'), /\bworkflow_ids?\b/, 'Agents must not own Workflow assignments');
    assert.doesNotMatch(agentSchemas, /\btarget(?:Id|Type|Scope|Ref|Binding|Tool|Skill)\b/i);
    assert.doesNotMatch(workflowSchemas, /\btarget(?:Id|Type|Scope|Ref|Binding|Tool|Skill)\b/i);
    assert.doesNotMatch(agentSchemas, /\bagentVersion\b/);
    assert.doesNotMatch(workflowSchemas, /\bworkflowVersion\b/);
    assert.match(executionClient, /scope_type: 'agent_chat', agent_id: run\.agentId/);
    assert.match(executionClient, /scope_type: 'workspace'[\s\S]*?workflow_id: run\.workflowId/);
    assert.doesNotMatch(agentBootstrap, /routing: \{[^}]*target_scoped/);
    assert.doesNotMatch(workflowBootstrap, /routing: \{[^}]*target_scoped/);
  });

  it('keeps direct Agent conversations off Workflow persistence and dispatch', () => {
    const directAgentRuntime = `${agentConversationController}\n${agentConversationRepository}`;
    assert.doesNotMatch(directAgentRuntime, /workflow_(?:definitions|sessions|executions|runs)/);
    assert.doesNotMatch(directAgentRuntime, /dispatchWorkflowRunToExecutionEngine/);
    assert.match(agentConversationController, /enqueueInteractiveRunDispatch/);
  });

  it('keeps target inventory and connector lifecycle out of Agent and Workflow readiness', () => {
    assert.doesNotMatch(targetToolSync, /refreshAgentReadiness|refreshWorkflowReadiness/);
    assert.doesNotMatch(targetToolSync, /repository-agents|repository-workflows/);
    assert.doesNotMatch(workspaceMcpSpecs, /listWorkspaceTargetSnapshot|resolveTargetRunTools/);
    assert.match(workspaceMcpSpecs, /TARGETS_MCP_CATALOG/);
  });

  it('retries from the prior immutable root scope instead of current Agent definitions', () => {
    assert.equal(executionController.includes('const pinnedScope = previous.compiledAccessScope'), true);
    assert.equal(executionController.includes('compileWorkflowScope'), false);
  });
});
