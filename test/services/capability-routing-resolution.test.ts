import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveCapabilityRoutingMappings } from '../../src/services/capability-routing-resolution.js';
import type { AgentDefinition } from '../../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../../src/types/capability-routing.js';

function agent(patch: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-documents',
    workspaceId: 'workspace-1',
    name: 'Document specialist',
    avatarEmoji: '🤖',
    instructions: 'Create documents.',
    status: 'active',
    reviewState: 'reviewed',
    providerType: 'internal',
    ownerUserId: 'user-1',
    createdBy: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    mcpServers: [],
    mcpTools: [],
    mcpInstallations: [],
    tools: ['documents.create'],
    nativeToolConfigs: {},
    skills: [],
    skillInstallations: [],
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: ['documents.create'],
    readiness: { status: 'ready', reasons: [] },
    ...patch
  };
}

function mapping(patch: Partial<CapabilityRoutingMapping> = {}): CapabilityRoutingMapping {
  return {
    id: 'route-documents',
    workspaceId: 'workspace-1',
    capabilityId: 'documents.create',
    agentId: 'agent-documents',
    status: 'active',
    reviewState: 'reviewed',
    priority: 10,
    mcpTools: [],
    nativeToolIds: ['documents.create'],
    skillIds: [],
    createdBy: 'user-1',
    reviewedBy: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...patch
  };
}

describe('capability routing resolution', () => {
  it('derives a reviewed route from an assigned workspace-native tool', () => {
    const resolved = resolveCapabilityRoutingMappings([agent()], []);

    assert.deepEqual(resolved.map((route) => ({
      capabilityId: route.capabilityId,
      agentId: route.agentId,
      reviewState: route.reviewState,
      nativeToolIds: route.nativeToolIds
    })), [{
      capabilityId: 'documents.create',
      agentId: 'agent-documents',
      reviewState: 'reviewed',
      nativeToolIds: ['documents.create']
    }]);
  });

  it('preserves an explicit reviewed route instead of duplicating it', () => {
    const explicit = mapping();
    const resolved = resolveCapabilityRoutingMappings([agent()], [explicit]);

    assert.deepEqual(resolved, [explicit]);
  });

  it('does not derive routes for semantic capabilities without assigned native tools', () => {
    const resolved = resolveCapabilityRoutingMappings([
      agent({ tools: [], semanticCapabilityIds: ['documents.create', 'external.documents.create'] })
    ], []);

    assert.deepEqual(resolved, []);
  });
});
