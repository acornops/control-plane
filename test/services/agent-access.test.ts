import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../../src/auth/authorization.js';
import { compileAgentRunScope } from '../../src/services/agent-access.js';
import type { AgentDefinition } from '../../src/types/agents.js';

function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    name: 'Incident analyst',
    description: 'Collects cluster signals and drafts incident summaries.',
    instructions: 'Use read-only tools and summarize operational risk.',
    status: 'active',
    source: 'user',
    providerType: 'internal',
    version: 3,
    ownerUserId: 'owner-1',
    createdBy: 'owner-1',
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    mcpServers: ['acornops-target-agent'],
    tools: ['events.search', 'inventory.resources.list', 'logs.summarize'],
    skills: ['acornops-observability'],
    contextGrants: ['target_inventory', 'workspace_metadata'],
    targetScope: { type: 'workspace', targetTypes: ['kubernetes'] },
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    triggers: [],
    activity: { runCount: 0 },
    ...overrides
  };
}

describe('agent access compiler', () => {
  it('compiles signed run claims for an active custom agent', () => {
    const compiled = compileAgentRunScope({
      agent: createAgent(),
      actor: {
        userId: 'user-operator',
        role: 'operator',
        permissions: capabilitiesToPermissions([
          'read_workspace_data',
          'create_read_only_runs'
        ])
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory'],
      triggerId: 'trigger-manual'
    });

    assert.deepEqual(compiled, {
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      agentVersion: 3,
      triggerId: 'trigger-manual',
      actor: {
        userId: 'user-operator',
        role: 'operator'
      },
      mcpServers: ['acornops-target-agent'],
      tools: ['events.search', 'inventory.resources.list', 'logs.summarize'],
      toolOperations: {
        'events.search': 'read',
        'inventory.resources.list': 'read',
        'logs.summarize': 'read'
      },
      enabledSkills: ['acornops-observability'],
      contextGrants: ['target_inventory', 'workspace_metadata'],
      approvalGates: ['Before write-capable tools'],
      targetScope: { type: 'workspace', targetTypes: ['kubernetes'] },
      jwtClaims: {
        scope: { type: 'workspace' },
        agent_id: 'agent-1',
        agent_version: 3,
        trigger_id: 'trigger-manual',
        permissions: {
          allowed_tools: ['events.search', 'inventory.resources.list', 'logs.summarize'],
          allowed_tool_operations: {
            'events.search': 'read',
            'inventory.resources.list': 'read',
            'logs.summarize': 'read'
          },
          context_grants: ['target_inventory', 'workspace_metadata']
        }
      }
    });
  });
});
