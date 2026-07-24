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
    assert.match(schema, /source_type = ANY \(ARRAY\['workflow'::text, 'target'::text\]\)/);
  });

  it('contains none of the removed Agent-run or Manager-Agent schema', () => {
    for (const removed of [
      'agent_activity',
      'agent_run_events',
      'agent_triggers',
      'workflow_delegations',
      'workflow_run_id',
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
    assert.equal(agentSchemas.includes('workflowUsage:'), true);
  });

  it('retries from the prior immutable root scope instead of current Agent definitions', () => {
    assert.equal(executionController.includes('const pinnedScope = previous.compiledAccessScope'), true);
    assert.equal(executionController.includes('compileWorkflowScope'), false);
  });
});
