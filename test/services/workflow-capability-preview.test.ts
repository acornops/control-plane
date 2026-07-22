import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentDefinition } from '../../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../../src/types/capability-routing.js';
import type { TargetAgentRegistration, TargetSummary } from '../../src/types/domain.js';
import type { CompiledWorkflowAccessScope, WorkflowDefinitionForAccess } from '../../src/types/workflows.js';
import { narrowWorkflowScopeToTargetTools, workflowTargetCandidates } from '../../src/services/workflow-capability-preview.js';
import type { TargetRunToolResolution } from '../../src/services/target-run-tool-resolution.js';

const agent = {
  id: 'agent-target', workspaceId: 'workspace-1', version: 2, status: 'active', reviewState: 'reviewed', kind: 'specialist',
  targetScope: { type: 'selected_target', targetTypes: ['kubernetes', 'virtual_machine'] }
} as AgentDefinition;

const workflow = {
  id: 'workflow-target', workspaceId: 'workspace-1', version: 3, agentIds: [agent.id], entryAgentId: agent.id,
  executionMode: 'direct',
  resourceRequirements: [{
    type: 'target', minimum: 1, maximum: 1, requiredOperations: ['read'],
    constraints: { targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] }
  }],
  capabilityPolicy: { mode: 'read_only', restrictionMode: 'restrict', semanticCapabilityIds: ['target.diagnostics.read'], contextGrants: [], maxRuntimeSeconds: 60, retentionDays: 30, approvalRequirements: [] }
} as WorkflowDefinitionForAccess;

const targets: TargetSummary[] = [
  { id: 'kube-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Kubernetes', status: 'online', metadata: {}, createdAt: '', updatedAt: '' },
  { id: 'vm-1', workspaceId: 'workspace-1', targetType: 'virtual_machine', name: 'VM', status: 'online', metadata: {}, createdAt: '', updatedAt: '' },
  { id: 'offline-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Offline', status: 'offline', metadata: {}, createdAt: '', updatedAt: '' },
  { id: 'unknown-1', workspaceId: 'workspace-1', targetType: 'virtual_machine', name: 'Unknown', status: 'unknown', metadata: {}, createdAt: '', updatedAt: '' }
];

function mapping(capabilityId: string, targetId: string, operation: 'read' | 'write'): CapabilityRoutingMapping {
  return {
    id: `${capabilityId}:${targetId}`, workspaceId: 'workspace-1', capabilityId, version: 1, agentId: agent.id,
    agentVersion: agent.version, status: 'active', reviewState: 'reviewed', priority: 10,
    targetTypes: [], targetIds: [targetId], mcpTools: [], nativeToolIds: [], invocationScopes: ['workflow'], skillIds: [], contextGrants: [],
    targetToolRefs: [{ serverId: 'builtin-target', toolName: operation === 'read' ? 'query_logs' : 'restart_service', alias: operation === 'read' ? 'query_logs' : 'restart_service', operation }],
    createdBy: 'system', createdAt: '', updatedAt: ''
  };
}

function registration(targetId: string, capabilities: string[]): TargetAgentRegistration {
  const targetType = targets.find((target) => target.id === targetId)?.targetType || 'kubernetes';
  return { targetId, targetType, workspaceId: 'workspace-1', agentKeyHash: 'hash', keyVersion: 1, capabilities };
}

describe('workflow capability target candidates', () => {
  it('returns Kubernetes and VM diagnostics targets as ready and keeps offline and unknown targets unavailable', () => {
    const mappings = targets.flatMap((target) => [mapping('target.diagnostics.read', target.id, 'read')]);
    const candidates = workflowTargetCandidates({
      workflow, agents: [agent], semanticCapabilityIds: ['target.diagnostics.read'], mappings, targets,
      registrations: targets.map((target) => registration(target.id, ['read']))
    });
    assert.deepEqual(candidates.map(({ id, status, reasonCode }) => ({ id, status, reasonCode })), [
      { id: 'kube-1', status: 'ready', reasonCode: undefined },
      { id: 'offline-1', status: 'unavailable', reasonCode: 'TARGET_OFFLINE' },
      { id: 'unknown-1', status: 'unavailable', reasonCode: 'TARGET_STATUS_UNKNOWN' },
      { id: 'vm-1', status: 'ready', reasonCode: undefined }
    ]);
  });

  it('returns a read-only VM as unsupported for remediation while Kubernetes remains ready', () => {
    const remediationWorkflow = {
      ...workflow,
      capabilityPolicy: { ...workflow.capabilityPolicy, mode: 'read_write' as const, semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'], approvalRequirements: ['Before every write'] }
    };
    const mappings = targets.flatMap((target) => [
      mapping('target.diagnostics.read', target.id, 'read'),
      mapping('target.remediation.write', target.id, 'write')
    ]);
    const candidates = workflowTargetCandidates({
      workflow: remediationWorkflow, agents: [agent], semanticCapabilityIds: remediationWorkflow.capabilityPolicy.semanticCapabilityIds,
      mappings, targets: targets.filter((target) => target.id === 'kube-1' || target.id === 'vm-1'),
      registrations: [registration('kube-1', ['read', 'write']), registration('vm-1', ['read'])]
    });
    assert.equal(candidates[0].status, 'ready');
    assert.deepEqual(candidates[1], {
      id: 'vm-1', name: 'VM', targetType: 'virtual_machine', status: 'unsupported',
      reasonCode: 'TARGET_WRITE_UNSUPPORTED',
      reason: 'This target currently advertises diagnostics only; remediation requires write capability.'
    });
  });

  it('fails closed when a required mapping or target tool reference is missing', () => {
    const missing = workflowTargetCandidates({
      workflow, agents: [agent], semanticCapabilityIds: ['target.diagnostics.read'], mappings: [], targets: [targets[0]],
      registrations: [registration('kube-1', ['read', 'write'])]
    });
    assert.equal(missing[0].reasonCode, 'CAPABILITY_MAPPING_UNAVAILABLE');
    const withoutTools = workflowTargetCandidates({
      workflow, agents: [agent], semanticCapabilityIds: ['target.diagnostics.read'],
      mappings: [{ ...mapping('target.diagnostics.read', 'kube-1', 'read'), targetToolRefs: [] }], targets: [targets[0]],
      registrations: [registration('kube-1', ['read', 'write'])]
    });
    assert.equal(withoutTools[0].reasonCode, 'TARGET_TOOL_MAPPING_UNAVAILABLE');
  });

  it('narrows public scope and JWT tool references through the same exact target intersection', () => {
    const targetMapping = mapping('target.diagnostics.read', 'kube-1', 'read');
    const scope = {
      tools: ['direct_tool', 'query_logs'],
      toolOperations: { direct_tool: 'read', query_logs: 'read' },
      mcpTools: [{ serverId: 'direct-server', toolName: 'direct_tool' }],
      targetToolRefs: targetMapping.targetToolRefs,
      jwtClaims: { permissions: { allowed_tools: ['direct_tool', 'query_logs'], allowed_tool_refs: [], allowed_tool_operations: {}, context_grants: [] } }
    } as unknown as CompiledWorkflowAccessScope;
    const resolution = {
      allowedToolNames: ['query_logs'],
      allowedToolRefs: [{ serverId: 'builtin-target', toolName: 'query_logs' }],
      allowedToolOperations: { query_logs: 'read' },
      allowedToolSpecs: [{ name: 'query_logs', server_id: 'builtin-target', tool_name: 'query_logs', description: 'Read logs', input_schema: {}, capability: 'read' }],
      previewItems: [{ id: 'query_logs', name: 'query_logs', description: 'Read logs', capability: 'read', runtimeKind: 'function', source: 'builtin' }]
    } as TargetRunToolResolution;

    const narrowed = narrowWorkflowScopeToTargetTools({ scope, mappings: [targetMapping], resolution });

    assert.deepEqual(narrowed.scope.targetToolRefs, [{ serverId: 'builtin-target', toolName: 'query_logs' }]);
    assert.deepEqual(narrowed.scope.jwtClaims.permissions.allowed_tool_refs, [
      { server_id: 'direct-server', tool_name: 'direct_tool' },
      { server_id: 'builtin-target', tool_name: 'query_logs' }
    ]);
  });
});
