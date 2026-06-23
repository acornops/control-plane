import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../../src/auth/authorization.js';
import {
  compileWorkflowAccessScope,
  WorkflowAccessDeniedError,
  type WorkflowDefinitionForAccess
} from '../../src/services/workflow-access.js';

function createWorkflow(overrides: Partial<WorkflowDefinitionForAccess> = {}): WorkflowDefinitionForAccess {
  return {
    id: 'workflow-1',
    workspaceId: 'workspace-1',
    version: 7,
    name: 'Audit workspace MCP exposure',
    requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
    policy: {
      mode: 'read_only',
      maxRuntimeSeconds: 600,
      retentionDays: 90,
      approvalRequirements: []
    },
    steps: [
      {
        id: 'inventory',
        title: 'Inventory MCP scope',
        requiredInputs: ['scope'],
        enabledSkills: ['acornops-security-baseline'],
        allowedMcpServers: ['audit-log', 'workspace-registry'],
        allowedTools: ['roles.permissions.read', 'mcp.tools.list', 'mcp.servers.list'],
        contextGrants: ['workspace_metadata', 'audit_events'],
        approvalRequired: false
      },
      {
        id: 'summarize',
        title: 'Summarize exposure',
        requiredInputs: [],
        enabledSkills: ['acornops-security-baseline'],
        allowedMcpServers: ['audit-log'],
        allowedTools: ['audit.events.search', 'mcp.tools.list'],
        contextGrants: ['audit_events'],
        approvalRequired: false
      }
    ],
    ...overrides
  };
}

describe('workflow access compiler', () => {
  it('compiles stable read-only workflow grants for an operator', () => {
    const compiled = compileWorkflowAccessScope({
      workflow: createWorkflow(),
      actor: {
        userId: 'user-operator',
        role: 'operator',
        permissions: capabilitiesToPermissions([
          'read_workspace_data',
          'create_sessions',
          'create_read_only_runs'
        ])
      },
      approvedContextGrants: ['workspace_metadata', 'audit_events']
    });

    assert.deepEqual(compiled, {
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
      workflowVersion: 7,
      actor: {
        userId: 'user-operator',
        role: 'operator'
      },
      mode: 'read_only',
      requiredPermissions: ['create_read_only_runs', 'read_workspace_data'],
      grantedCapabilities: ['create_read_only_runs', 'read_workspace_data'],
      mcpServers: ['audit-log', 'workspace-registry'],
      tools: ['audit.events.search', 'mcp.servers.list', 'mcp.tools.list', 'roles.permissions.read'],
      toolOperations: {
        'audit.events.search': 'read',
        'mcp.servers.list': 'read',
        'mcp.tools.list': 'read',
        'roles.permissions.read': 'read'
      },
      enabledSkills: ['acornops-security-baseline'],
      contextGrants: ['audit_events', 'workspace_metadata'],
      approvalGates: [],
      jwtClaims: {
        scope: { type: 'workspace' },
        workflow_id: 'workflow-1',
        workflow_version: 7,
        permissions: {
          allowed_tools: ['audit.events.search', 'mcp.servers.list', 'mcp.tools.list', 'roles.permissions.read'],
          allowed_tool_operations: {
            'audit.events.search': 'read',
            'mcp.servers.list': 'read',
            'mcp.tools.list': 'read',
            'roles.permissions.read': 'read'
          },
          context_grants: ['audit_events', 'workspace_metadata']
        }
      }
    });
  });

  it('rejects read-write workflows when the actor lacks read-write run capability', () => {
    assert.throws(
      () => compileWorkflowAccessScope({
        workflow: createWorkflow({
          requiredPermissions: ['read_workspace_data', 'create_read_write_runs'],
          policy: {
            mode: 'read_write',
            maxRuntimeSeconds: 900,
            retentionDays: 90,
            approvalRequirements: ['Before changing MCP server enablement']
          },
          steps: [
            {
              id: 'mutate-mcp',
              title: 'Update MCP server',
              requiredInputs: [],
              enabledSkills: ['acornops-security-baseline'],
              allowedMcpServers: ['workspace-registry'],
              allowedTools: ['mcp.servers.update'],
              contextGrants: ['workspace_metadata'],
              approvalRequired: true
            }
          ]
        }),
        actor: {
          userId: 'user-operator',
          role: 'operator',
          permissions: capabilitiesToPermissions([
            'read_workspace_data',
            'create_sessions',
            'create_read_only_runs'
          ])
        },
        approvedContextGrants: ['workspace_metadata']
      }),
      (err) => err instanceof WorkflowAccessDeniedError
        && err.code === 'WORKFLOW_PERMISSION_DENIED'
        && err.missingPermissions.includes('create_read_write_runs')
    );
  });

  it('rejects workflow context grants that were not explicitly approved', () => {
    assert.throws(
      () => compileWorkflowAccessScope({
        workflow: createWorkflow({
          steps: [
            {
              id: 'read-selected-chats',
              title: 'Read selected chats',
              requiredInputs: ['chatSessions'],
              enabledSkills: ['skill-creator'],
              allowedMcpServers: ['workspace-chat'],
              allowedTools: ['chat.sessions.read_selected'],
              contextGrants: ['selected_chat_sessions'],
              approvalRequired: true
            }
          ]
        }),
        actor: {
          userId: 'user-operator',
          role: 'operator',
          permissions: capabilitiesToPermissions([
            'read_workspace_data',
            'create_sessions',
            'create_read_only_runs'
          ])
        },
        approvedContextGrants: ['workspace_metadata']
      }),
      (err) => err instanceof WorkflowAccessDeniedError
        && err.code === 'WORKFLOW_CONTEXT_GRANT_DENIED'
        && err.missingContextGrants.includes('selected_chat_sessions')
    );
  });
});
