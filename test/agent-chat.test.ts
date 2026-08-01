import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agentConversationPolicyAllowsAccess,
  compileAgentConversationMessage,
  defaultAgentConversationAccessMode,
} from '../src/services/agent-chat.js';
import { resolveAgentChatRunTools } from '../src/services/agent-chat-run-tools.js';
import { resolveRunSkillSnapshots } from '../src/services/run-skill-snapshots.js';
import { targetToolSpecMatchesRoute } from '../src/services/target-run-tool-resolution.js';
import { compileAgentCapabilityProjection } from '../src/services/agent-capability-access.js';
import { agentChatRunSnapshotIsValid } from '../src/controllers/internal-agent-chat-bootstrap.js';
import { resolveTargetsMcpSelection } from '../src/controllers/internal-approval-controller.js';
import { repo } from '../src/store/repository.js';
import type { CompiledAgentChatAccessScope } from '../src/types/agent-chat.js';
import type { AgentDefinition } from '../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../src/types/capability-routing.js';
import type { ChatSession, Run } from '../src/types/domain.js';

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
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: ['incident.read'],
    readiness: { status: 'ready', reasons: [] },
    ...overrides
  };
}

function run(agentSnapshot: AgentDefinition, overrides: Partial<Run> = {}): Run {
  const compiledAccessScope = {
    agentId: agentSnapshot.id,
    workspaceId: agentSnapshot.workspaceId,
    actor: { userId: 'user-1', role: 'admin' },
    requiredPermissions: ['create_read_only_runs'],
    grantedCapabilities: ['create_read_only_runs'],
    mcpTools: [],
    tools: agentSnapshot.tools,
    toolOperations: Object.fromEntries(agentSnapshot.tools.map((tool) => [tool, 'read'])),
    nativeToolConfigs: structuredClone(agentSnapshot.nativeToolConfigs),
    enabledSkills: agentSnapshot.skillInstallations.filter((skill) => skill.enabled).map((skill) => skill.id),
    mode: 'read_only',
    permissionMode: 'read_only',
    principal: { type: 'user', id: 'user-1' },
    contextGrants: [],
    resourceBindings: [],
    resourceResolutionPhase: 'run_exact'
  } as unknown as CompiledAgentChatAccessScope;
  return {
    id: 'run-1',
    workspaceId: agentSnapshot.workspaceId,
    conversationKind: 'agent_chat',
    agentId: agentSnapshot.id,
    agentSnapshot,
    compiledAccessScope,
    sessionId: 'session-1',
    messageId: 'message-1',
    principal: { type: 'user', id: 'user-1' },
    llmProvider: 'openai',
    llmModel: 'gpt-5-nano',
    llmReasoningSummaryMode: 'off',
    llmReasoningEffort: 'low',
    toolAccessMode: 'read_only',
    status: 'running',
    requestedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    conversationKind: 'agent_chat',
    agentId: 'agent-1',
    createdBy: 'user-1',
    origin: 'manual',
    title: 'Incident analyst',
    status: 'open',
    preferredAccessMode: 'read_only',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    lastMessageAt: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-08-28T00:00:00.000Z',
    ...overrides
  };
}

function mapping(
  specialist: AgentDefinition,
  overrides: Partial<CapabilityRoutingMapping> = {}
): CapabilityRoutingMapping {
  return {
    id: 'mapping-1',
    workspaceId: specialist.workspaceId,
    capabilityId: 'incident.read',
    agentId: specialist.id,
    status: 'active',
    reviewState: 'reviewed',
    priority: 10,
    mcpTools: [],
    nativeToolIds: [],
    skillIds: [],
    contextGrants: [],
    createdBy: 'user-1',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
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

  it('normalizes each message into an exact empty-resource binding snapshot', () => {
    const compiled = compileAgentConversationMessage('Cafe\u0301');
    assert.equal(compiled.content, 'Café');
    assert.deepEqual(compiled.bindings, []);
    assert.match(compiled.promptDigest, /^[a-f0-9]{64}$/);
    assert.match(compiled.bindingDigest, /^[a-f0-9]{64}$/);
  });

  it('keeps an Agent usable when optional MCP capabilities have no current tool mapping', () => {
    const specialist = agent({ semanticCapabilityIds: ['infrastructure.diagnostics.read'] });
    const projection = compileAgentCapabilityProjection({
      agent: specialist,
      mappings: [],
      mode: 'read_only',
      restrictionMode: 'inherit',
      effectiveCapabilityIds: [],
      requestedContextGrants: [],
      approvalGates: []
    });
    assert.deepEqual(projection.semanticCapabilityIds, []);
    assert(projection.tools.includes('reports.pdf.generate'));
  });

  it('validates generic Targets MCP approval targets at call time', async (context) => {
    context.mock.method(repo, 'getTarget', async (workspaceId: string, targetId: string) => (
      workspaceId === 'workspace-1' && targetId === 'cluster-1'
        ? {
            id: targetId,
            workspaceId,
            targetType: 'kubernetes' as const,
            name: 'Cluster 1',
            status: 'online' as const,
            metadata: {},
            createdAt: '2026-07-29T00:00:00.000Z',
            updatedAt: '2026-07-29T00:00:00.000Z'
          }
        : null
    ));
    assert.deepEqual(await resolveTargetsMcpSelection({
      workspaceId: 'workspace-1',
      serverId: 'targets',
      arguments: { target_id: 'cluster-1', target_type: 'kubernetes' }
    }), { kind: 'valid', targetId: 'cluster-1', targetType: 'kubernetes' });
    assert.deepEqual(await resolveTargetsMcpSelection({
      workspaceId: 'workspace-2',
      serverId: 'targets',
      arguments: { target_id: 'cluster-1', target_type: 'kubernetes' }
    }), { kind: 'invalid' });
    assert.deepEqual(await resolveTargetsMcpSelection({
      workspaceId: 'workspace-1',
      serverId: 'targets',
      arguments: { target_id: 'cluster-1', target_type: 'virtual_machine' }
    }), { kind: 'invalid' });
  });

  it('advertises only workspace-native tools that support Agent-chat invocation', async () => {
    const snapshot = agent({ tools: ['http.fetch.get', 'reports.pdf.generate'] });
    const resolved = await resolveAgentChatRunTools(run(snapshot));
    assert.deepEqual(resolved.platformFunctions, [{
      id: 'reports.pdf.generate',
      model_alias: 'acornops_generate_pdf_report'
    }]);
    assert(!resolved.allowedToolNames.includes('http.fetch.get'));
    assert(!resolved.allowedToolNames.includes('acornops_fetch'));
    assert(resolved.allowedToolNames.includes('acornops_generate_pdf_report'));
  });

  it('preserves pinned provider-native tool configuration', async () => {
    const snapshot = agent({
      tools: ['web_search'],
      nativeToolConfigs: { web_search: { allowedDomains: ['status.example.test'] } }
    });
    const resolved = await resolveAgentChatRunTools(run(snapshot));
    assert.deepEqual(resolved.allowedNativeTools, [{
      id: 'web_search',
      config: { allowedDomains: ['status.example.test'] }
    }]);
  });

  it('combines direct and capability-routed MCP tools without a target-specific Agent field', () => {
    const snapshot = agent({
      mcpInstallations: [{
        id: 'server-observability',
        name: 'Observability service',
        url: 'https://mcp.example.test',
        enabled: true,
        credentialMode: 'workspace',
        revision: 1,
        tools: [{
          serverId: 'server-observability',
          toolName: 'host_summary',
          alias: 'host_summary',
          description: 'Read a host summary.',
          inputSchema: { type: 'object' },
          capability: 'read',
          enabled: true,
          reviewState: 'approved',
          riskLevel: 'low',
          autoAllowed: true
        }]
      }]
    });
    const projection = compileAgentCapabilityProjection({
      agent: snapshot,
      mappings: [mapping(snapshot, {
        mcpTools: [{
          serverId: 'inventory-mapping',
          toolName: 'inventory',
          alias: 'infrastructure_inventory',
          operation: 'read'
        }, {
          serverId: 'targets',
          toolName: 'resource_status',
          alias: 'resource_status',
          operation: 'read'
        }],
        nativeToolIds: ['workspace.metadata.read'],
        skillIds: ['infrastructure-diagnostics'],
        contextGrants: ['infrastructure_inventory']
      })],
      mode: 'read_only',
      restrictionMode: 'inherit',
      effectiveCapabilityIds: ['incident.read'],
      requestedContextGrants: [],
      approvalGates: []
    });

    assert.deepEqual(projection.mcpTools, [
      { serverId: 'server-observability', toolName: 'host_summary' },
      { serverId: 'inventory-mapping', toolName: 'inventory' },
      { serverId: 'targets', toolName: 'resource_status' }
    ]);
    assert(projection.tools.includes('host_summary'));
    assert(projection.tools.includes('resource_status'));
    assert(projection.tools.includes('infrastructure_inventory'));
    assert(projection.tools.includes('workspace.metadata.read'));
    assert(projection.enabledSkills.includes('infrastructure-diagnostics'));
    assert(projection.contextGrants.includes('infrastructure_inventory'));
  });

  it('does not synthesize unresolved capability aliases as generic tools', async () => {
    const snapshot = agent();
    const baseRun = run(snapshot);
    const resolved = await resolveAgentChatRunTools({
      ...baseRun,
      compiledAccessScope: {
        ...baseRun.compiledAccessScope!,
        tools: ['missing_mcp_tool'],
        mcpTools: [{ serverId: 'missing-server', toolName: 'missing_tool' }],
        toolOperations: { missing_mcp_tool: 'read' }
      }
    });

    assert.deepEqual(resolved.allowedToolNames, []);
    assert.deepEqual(resolved.allowedToolRefs, []);
    assert.deepEqual(resolved.allowedToolSpecs, []);
  });

  it('requires a dynamic target route to match the live tool operation', () => {
    const spec = {
      name: 'host_summary',
      server_id: 'target-tools',
      tool_name: 'host_summary',
      description: 'Read a host summary.',
      input_schema: { type: 'object' },
      capability: 'write' as const
    };
    assert.equal(targetToolSpecMatchesRoute(spec, {
      serverId: 'target-tools', toolName: 'host_summary', operation: 'read'
    }), false);
    assert.equal(targetToolSpecMatchesRoute(spec, {
      serverId: 'target-tools', toolName: 'host_summary', operation: 'write'
    }), true);
  });

  it('fails closed when a pinned MCP alias or operation no longer matches its tool snapshot', async () => {
    const snapshot = agent({
      mcpInstallations: [{
        id: 'server-1',
        name: 'Incident service',
        url: 'https://mcp.example.test',
        enabled: true,
        credentialMode: 'workspace',
        revision: 1,
        tools: [{
          serverId: 'server-1',
          toolName: 'incidents.update',
          alias: 'incidents_update',
          description: 'Update an incident.',
          inputSchema: { type: 'object' },
          capability: 'write',
          enabled: true,
          reviewState: 'approved',
          riskLevel: 'high',
          autoAllowed: false
        }]
      }]
    });
    const baseRun = run(snapshot);
    const resolved = await resolveAgentChatRunTools({
      ...baseRun,
      compiledAccessScope: {
        ...baseRun.compiledAccessScope!,
        mcpTools: [{ serverId: 'server-1', toolName: 'incidents.update' }],
        tools: ['incidents_update'],
        toolOperations: { incidents_update: 'read' }
      }
    });

    assert.deepEqual(resolved.allowedToolNames, []);
    assert.deepEqual(resolved.allowedToolRefs, []);
    assert.deepEqual(resolved.allowedToolSpecs, []);
  });

  it('pins enabled Agent skills with deterministic refs and exact file sizes', () => {
    const snapshot = agent({
      skillInstallations: [{
        id: 'skill-1',
        name: 'Incident analysis',
        description: 'Analyze an incident.',
        enabled: true,
        revision: 2,
        contentDigest: 'sha256:skill',
        source: { type: 'manual' },
        files: [{ path: 'SKILL.md', content: 'Analyze carefully.', contentDigest: 'sha256:file' }]
      }, {
        id: 'skill-disabled',
        name: 'Disabled',
        description: 'Do not load.',
        enabled: false,
        revision: 1,
        contentDigest: 'sha256:disabled',
        source: { type: 'manual' },
        files: []
      }]
    });
    const pinnedRun = run(snapshot);
    const skills = resolveRunSkillSnapshots(snapshot, pinnedRun.compiledAccessScope.enabledSkills);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].ref, 'skill_1');
    assert.equal(skills[0].installation.id, 'skill-1');
    assert.equal(skills[0].totalBytes, Buffer.byteLength('Analyze carefully.', 'utf8'));
  });

  it('rejects bootstrap snapshots whose session, Agent, scope, or principal identity diverges', () => {
    const snapshot = agent();
    const validRun = run(snapshot);
    assert.equal(agentChatRunSnapshotIsValid(validRun, session()), true);
    assert.equal(agentChatRunSnapshotIsValid({ ...validRun, conversationKind: 'target_chat' }, session()), false);
    assert.equal(agentChatRunSnapshotIsValid(validRun, session({ agentId: 'agent-other' })), false);
    assert.equal(agentChatRunSnapshotIsValid({
      ...validRun,
      compiledAccessScope: { ...validRun.compiledAccessScope!, agentId: 'agent-other' }
    }, session()), false);
    assert.equal(agentChatRunSnapshotIsValid({
      ...validRun,
      principal: { type: 'user', id: 'user-other' }
    }, session()), false);
    assert.equal(agentChatRunSnapshotIsValid({
      ...validRun,
      compiledAccessScope: { ...validRun.compiledAccessScope!, mode: 'read_write' }
    }, session()), false);
    assert.equal(agentChatRunSnapshotIsValid(validRun, session({ preferredAccessMode: 'read_write' })), true);
  });
});
