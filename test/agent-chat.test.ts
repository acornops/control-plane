import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agentConversationPolicyAllowsAccess,
  defaultAgentConversationAccessMode,
  pinnedAgentCapabilityRevocation
} from '../src/services/agent-chat.js';
import { isAgentChatCarrier } from '../src/store/repository-workflows.js';
import type { AgentDefinition } from '../src/types/agents.js';
import type { CompiledWorkflowAccessScope, WorkflowDefinitionForAccess } from '../src/types/workflows.js';

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    name: 'Incident analyst',
    instructions: 'Inspect the available incident evidence.',
    status: 'active',
    origin: { type: 'manual' },
    reviewState: 'reviewed',
    providerType: 'internal',
    version: 4,
    ownerUserId: 'user-1',
    createdBy: 'user-1',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    mcpServers: ['server-1'],
    mcpTools: [{ serverId: 'server-1', toolName: 'incidents.read' }],
    mcpInstallations: [],
    tools: ['reports.pdf.generate'],
    nativeToolConfigs: {},
    skills: ['incident-analysis'],
    skillInstallations: [],
    contextGrants: ['workspace.summary'],
    targetScope: { type: 'workspace' },
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: ['incident.read'],
    workflowUsage: { workflowRunCount: 0 },
    readiness: { status: 'ready', reasons: [] },
    ...overrides
  };
}

function pinnedScope(snapshot: AgentDefinition): CompiledWorkflowAccessScope {
  return {
    selectedAgentSnapshots: [snapshot]
  } as CompiledWorkflowAccessScope;
}

describe('Agent chat contract', () => {
  it('derives conversation access from Agent policy and creator capability', () => {
    assert.equal(defaultAgentConversationAccessMode('read_only', true, false), 'read_only');
    assert.equal(defaultAgentConversationAccessMode('read_only', false, true), null);
    assert.equal(defaultAgentConversationAccessMode('ask_before_changes', true, false), 'read_only');
    assert.equal(defaultAgentConversationAccessMode('ask_before_changes', true, true), 'read_write');
    assert.equal(defaultAgentConversationAccessMode('ask_before_changes', false, true), 'read_write');
    assert.equal(defaultAgentConversationAccessMode('auto_allowed_changes', true, false), 'read_only');
    assert.equal(defaultAgentConversationAccessMode('auto_allowed_changes', true, true), 'read_write');
    assert.equal(defaultAgentConversationAccessMode('auto_allowed_changes', false, false), null);
  });

  it('treats read-only Agent policy as a hard access ceiling', () => {
    assert.equal(agentConversationPolicyAllowsAccess('read_only', 'read_only'), true);
    assert.equal(agentConversationPolicyAllowsAccess('read_only', 'read_write'), false);
    assert.equal(agentConversationPolicyAllowsAccess('ask_before_changes', 'read_write'), true);
    assert.equal(agentConversationPolicyAllowsAccess('auto_allowed_changes', 'read_write'), true);
  });

  it('recognizes only protected system-managed Agent chat carriers', () => {
    const workflow = {
      origin: {
        type: 'agent_chat',
        agentId: 'agent-1',
        agentVersion: 4,
        systemManaged: true
      }
    } as WorkflowDefinitionForAccess;
    assert.equal(isAgentChatCarrier(workflow), true);
    assert.equal(isAgentChatCarrier({
      ...workflow,
      origin: { ...workflow.origin, systemManaged: false }
    }), false);
    assert.equal(isAgentChatCarrier({
      ...workflow,
      origin: { type: 'manual' }
    }), false);
  });

  it('fails closed for removed pinned capabilities and disabled Agents', () => {
    const pinned = agent();
    assert.deepEqual(pinnedAgentCapabilityRevocation(pinnedScope(pinned), pinned), []);

    const removed = agent({
      mcpServers: [],
      mcpTools: [],
      tools: [],
      skills: [],
      contextGrants: [],
      semanticCapabilityIds: []
    });
    assert.deepEqual(pinnedAgentCapabilityRevocation(pinnedScope(pinned), removed), [
      'MCP server server-1 was revoked.',
      'MCP tool server-1/incidents.read was revoked.',
      'Tool reports.pdf.generate was revoked.',
      'Skill incident-analysis was revoked.',
      'Context grant workspace.summary was revoked.',
      'Semantic capability incident.read was revoked.'
    ]);
    assert.deepEqual(
      pinnedAgentCapabilityRevocation(pinnedScope(pinned), agent({ status: 'disabled' })),
      ['Agent is no longer available for execution.']
    );
  });

  it('does not expand an existing conversation when capabilities are added later', () => {
    const pinned = agent({
      mcpServers: [],
      mcpTools: [],
      tools: [],
      skills: [],
      contextGrants: [],
      semanticCapabilityIds: []
    });
    const expanded = agent({
      mcpTools: [{ serverId: 'server-2', toolName: 'incidents.write' }],
      tools: ['reports.pdf.generate'],
      skills: ['incident-analysis']
    });
    assert.deepEqual(pinnedAgentCapabilityRevocation(pinnedScope(pinned), expanded), []);
    assert.deepEqual(pinnedScope(pinned).selectedAgentSnapshots[0].tools, []);
  });
});
