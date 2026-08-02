import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { createToolApproval } from '../src/controllers/internal-approval-controller.js';
import { getRunSkillSnapshot } from '../src/controllers/internal-execution-skill-controller.js';
import { callPlatformNativeTool } from '../src/controllers/internal-platform-native-tool-controller.js';
import { db } from '../src/infra/db.js';
import { compileAgentConversationRunScope } from '../src/services/agent-chat.js';
import { repo } from '../src/store/repository.js';
import { addAgentConversationSession } from '../src/store/repository-agent-conversations.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import type { CompiledAgentChatAccessScope } from '../src/types/agent-chat.js';
import type { AgentDefinition } from '../src/types/agents.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
after(closeAutomationDatabaseFixtures);

const actor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};

function responseStub() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    locals: {},
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; }
  };
}

async function callNative(runId: string, toolId: string, body: Record<string, unknown>) {
  const response = responseStub();
  await callPlatformNativeTool(
    { params: { runId, toolId }, body } as never,
    response as never,
    (error?: unknown) => { if (error) throw error; }
  );
  return response;
}

async function callApproval(runId: string, body: Record<string, unknown>) {
  const response = responseStub();
  await createToolApproval(
    { params: { runId }, body } as never,
    response as never,
    (error?: unknown) => { if (error) throw error; }
  );
  return response;
}

async function callSkill(runId: string, skillRef: string) {
  const response = responseStub();
  await getRunSkillSnapshot(
    { params: { runId, skillRef } } as never,
    response as never,
    (error?: unknown) => { if (error) throw error; }
  );
  return response;
}

async function addAgentRun(
  specialist: AgentDefinition,
  compiledAccessScope: CompiledAgentChatAccessScope,
  accessMode: 'read_only' | 'read_write'
) {
  const session = await addAgentConversationSession({
    workspaceId: 'workspace-1',
    agentId: specialist.id,
    createdBy: 'user-1',
    title: specialist.name,
    preferredAccessMode: accessMode
  });
  const message = await repo.addMessage(session.id, 'user', 'Run the Agent capability.');
  const runId = randomUUID();
  await repo.addRun({
    id: runId,
    workspaceId: 'workspace-1',
    conversationKind: 'agent_chat',
    agentId: specialist.id,
    agentSnapshot: specialist,
    compiledAccessScope,
    sessionId: session.id,
    messageId: message.id,
    principal: { type: 'user', id: 'user-1' },
    llmProvider: 'openai',
    llmModel: 'gpt-5-nano',
    llmReasoningSummaryMode: 'off',
    llmReasoningEffort: 'low',
    toolAccessMode: accessMode,
    status: 'running',
    requestedAt: new Date().toISOString()
  });
  return runId;
}

function compileScope(
  specialist: AgentDefinition,
  accessMode: 'read_only' | 'read_write'
) {
  return compileAgentConversationRunScope({
    agent: specialist,
    actor,
    accessMode,
    resourceBindings: [],
    promptDigest: 'a'.repeat(64),
    bindingDigest: 'b'.repeat(64)
  });
}

describe('Agent-chat native tools and approvals', () => {
  it('executes idempotent PDF artifacts against the pinned Agent run scope', async () => {
    const specialist = await getAgentDefinition('workspace-1', 'agent-incident-reporter');
    assert.ok(specialist);
    const scope = await compileScope(specialist, 'read_only');
    const runId = await addAgentRun(specialist, scope, 'read_only');
    const body = {
      toolCallId: 'agent-report-1',
      arguments: { title: 'Agent report', markdown: '# Agent report' }
    };
    const first = await callNative(runId, 'documents.create', body);
    const repeated = await callNative(runId, 'documents.create', body);
    assert.equal(first.statusCode, 200);
    assert.equal(
      (first.body as { structuredContent: { documentId: string } }).structuredContent.documentId,
      (repeated.body as { structuredContent: { documentId: string } }).structuredContent.documentId
    );
    const persisted = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM generated_documents WHERE conversation_run_id=$1 AND tool_call_id=$2',
      [runId, 'agent-report-1']
    );
    assert.equal(Number(persisted.rows[0].count), 1);
  });

  it('creates targetless approvals for exact Agent MCP write grants', async () => {
    const baseAgent = await getAgentDefinition('workspace-1', 'agent-incident-reporter');
    assert.ok(baseAgent);
    const specialist: AgentDefinition = {
      ...baseAgent,
      mcpServers: ['server-change'],
      mcpTools: [{ serverId: 'server-change', toolName: 'apply_change' }],
      mcpInstallations: [{
        id: 'server-change', name: 'Change service', url: 'https://mcp.example.test',
        enabled: true, credentialMode: 'workspace', revision: 1,
        tools: [{
          serverId: 'server-change', toolName: 'apply_change', alias: 'apply_change',
          description: 'Apply an approved change.', inputSchema: { type: 'object' },
          capability: 'write', enabled: true, reviewState: 'approved',
          riskLevel: 'high_risk', autoAllowed: false
        }]
      }],
      tools: ['apply_change'],
      permissionMode: 'ask_before_changes'
    };
    const scope = {
      ...(await compileScope(specialist, 'read_write')),
      mode: 'read_write' as const,
      permissionMode: 'ask_before_changes' as const,
      mcpTools: [{ serverId: 'server-change', toolName: 'apply_change' }],
      tools: ['apply_change'],
      toolOperations: { apply_change: 'write' as const }
    };
    const runId = await addAgentRun(specialist, scope, 'read_write');
    const response = await callApproval(runId, {
      toolCallId: 'agent-write-1', toolName: 'apply_change',
      toolRef: { serverId: 'server-change', toolName: 'apply_change' },
      summary: 'Apply the reviewed change', arguments: { value: 'safe' },
      continuation: { schema_version: 1, state: { step: 'awaiting_approval' } }
    });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { targetId?: string }).targetId, undefined);
    const persisted = await repo.getRunToolApproval((response.body as { id: string }).id);
    assert.equal(persisted?.targetId, undefined);
    assert.equal((await repo.getRun(runId))?.status, 'waiting_for_approval');
  });

  it('serves enabled skills from the immutable Agent run snapshot', async () => {
    const baseAgent = await getAgentDefinition('workspace-1', 'agent-incident-reporter');
    assert.ok(baseAgent);
    const specialist: AgentDefinition = {
      ...baseAgent,
      skills: ['incident-analysis'],
      skillInstallations: [{
        id: 'incident-analysis',
        name: 'Incident analysis',
        description: 'Analyze incident evidence.',
        enabled: true,
        revision: 1,
        contentDigest: 'sha256:skill',
        source: { type: 'manual' },
        files: [{ path: 'SKILL.md', content: 'Analyze carefully.', contentDigest: 'sha256:file' }]
      }]
    };
    const scope = {
      ...(await compileScope(specialist, 'read_only')),
      enabledSkills: ['incident-analysis']
    };
    const runId = await addAgentRun(specialist, scope, 'read_only');
    const response = await callSkill(runId, 'skill_1');
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { skill_id: string }).skill_id, 'incident-analysis');
    assert.deepEqual(
      (response.body as { files: Array<{ path: string; content: string }> }).files,
      [{ path: 'SKILL.md', content: 'Analyze carefully.', size_bytes: 18 }]
    );
  });
});
