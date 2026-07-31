import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityRoutingMapping } from '../../src/types/capability-routing.js';
import type { CompiledWorkflowAccessScope } from '../../src/types/workflows.js';
import { narrowWorkflowScopeToTargetTools } from '../../src/services/workflow-capability-preview.js';
import type { TargetRunToolResolution } from '../../src/services/target-run-tool-resolution.js';

const targetMapping: CapabilityRoutingMapping = {
  id: 'mapping-1', workspaceId: 'workspace-1', capabilityId: 'target.diagnostics.read', version: 1,
  agentId: 'agent-target', agentVersion: 2, status: 'active', reviewState: 'reviewed', priority: 10,
  targetTypes: ['kubernetes'], targetIds: ['kube-1'], mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
  targetToolRefs: [{ serverId: 'builtin-target', toolName: 'query_logs', alias: 'query_logs', operation: 'read' }],
  createdBy: 'system', createdAt: '', updatedAt: ''
};

describe('workflow target tool narrowing', () => {
  it('keeps exact delegated runs aligned across scope, routes, and JWT refs', () => {
    const scope = {
      tools: ['direct_tool', 'query_logs'],
      toolOperations: { direct_tool: 'read', query_logs: 'read' },
      mcpTools: [{ serverId: 'direct-server', toolName: 'direct_tool' }],
      targetToolRefs: targetMapping.targetToolRefs,
      targetToolRoutes: [{
        alias: 'query_logs', serverId: 'builtin-target', toolName: 'query_logs', operation: 'read',
        targetId: 'kube-1', targetType: 'kubernetes'
      }],
      jwtClaims: { permissions: {
        allowed_tools: ['direct_tool', 'query_logs'], allowed_tool_refs: [], allowed_tool_operations: {},
        allowed_target_tool_routes: [], context_grants: [], resource_bindings: []
      } }
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
    assert.deepEqual(narrowed.scope.targetToolRoutes, [{
      alias: 'query_logs', serverId: 'builtin-target', toolName: 'query_logs', operation: 'read',
      targetId: 'kube-1', targetType: 'kubernetes'
    }]);
    assert.deepEqual(narrowed.scope.jwtClaims.permissions.allowed_tool_refs, [
      { server_id: 'direct-server', tool_name: 'direct_tool' },
      { server_id: 'builtin-target', tool_name: 'query_logs' }
    ]);
  });
});
