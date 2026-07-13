import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../../src/auth/authorization.js';
import {
  compileWorkflowAccessScope,
  workflowToolOperation,
  WorkflowAccessDeniedError,
  type WorkflowDefinitionForAccess
} from '../../src/services/workflow-access.js';
import type { AgentDefinition } from '../../src/types/agents.js';

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

function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-incident',
    workspaceId: 'workspace-1',
    name: 'Incident analyst',
    description: 'Reads cluster signals.',
    instructions: 'Stay inside the assigned workflow scope.',
    status: 'active',
    source: 'system',
    kind: 'specialist_agent',
    providerType: 'internal',
    version: 2,
    ownerUserId: 'system',
    createdBy: 'system',
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    mcpServers: ['audit-log'],
    tools: ['audit.events.search', 'mcp.tools.list'],
    skills: ['acornops-security-baseline'],
    contextGrants: ['audit_events'],
    targetScope: { type: 'workspace' },
    approvalPolicy: { mode: 'none', writeToolsRequireApproval: false },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    triggers: [],
    activity: { runCount: 0 },
    ...overrides
  };
}

describe('workflow access compiler', () => {
  it('keeps canonical reads read-only and conservatively gates writes and unknown tools', () => {
    assert.equal(workflowToolOperation('repository.file.read', 'read_write'), 'read');
    assert.equal(workflowToolOperation('repository.tree.list', 'read_write'), 'read');
    assert.equal(workflowToolOperation('metrics.query', 'read_write'), 'read');
    assert.equal(workflowToolOperation('repository.commit.create', 'read_write'), 'write');
    assert.equal(workflowToolOperation('reports.pdf.generate', 'read_write'), 'write');
    assert.equal(workflowToolOperation('vendor.custom.operation', 'read_write'), 'write');
    assert.equal(workflowToolOperation('repository.commit.create', 'read_only'), 'read');
  });

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

  it('narrows workflow step scope to active agent grants without setting agent identity claims', () => {
    const compiled = compileWorkflowAccessScope({
      workflow: createWorkflow({
        steps: [
          {
            id: 'summarize',
            title: 'Summarize exposure',
            requiredInputs: [],
            agentIds: ['agent-incident'],
            enabledSkills: ['acornops-security-baseline', 'acornops-cross-repo-change'],
    allowedMcpServers: ['audit-log'],
    allowedTools: ['audit.events.search', 'mcp.tools.list'],
            contextGrants: ['audit_events', 'workspace_metadata'],
            approvalRequired: false
          }
        ]
      }),
      agents: [createAgent()],
      actor: {
        userId: 'user-operator',
        role: 'operator',
        permissions: capabilitiesToPermissions([
          'read_workspace_data',
          'create_sessions',
          'create_read_only_runs'
        ])
      },
      approvedContextGrants: ['audit_events']
    });

    assert.deepEqual(compiled.selectedAgents, [
      { stepId: 'summarize', agentIds: ['agent-incident'], agentVersions: { 'agent-incident': 2 } }
    ]);
    assert.deepEqual(compiled.mcpServers, ['audit-log']);
    assert.deepEqual(compiled.tools, ['audit.events.search', 'mcp.tools.list']);
    assert.deepEqual(compiled.enabledSkills, ['acornops-security-baseline']);
    assert.deepEqual(compiled.contextGrants, ['audit_events']);
    assert.equal(compiled.jwtClaims.agent_id, undefined);
    assert.equal(compiled.jwtClaims.agent_version, undefined);
  });

  it('inherits the selected agent scope when workflow restrictions are empty', () => {
    const compiled = compileWorkflowAccessScope({
      workflow: createWorkflow({
        enabledMcpServers: [],
        enabledSkills: [],
        steps: [
          {
            id: 'summarize',
            title: 'Summarize exposure',
            requiredInputs: [],
            agentIds: ['agent-incident'],
            enabledSkills: [],
            allowedMcpServers: [],
            allowedTools: [],
            contextGrants: [],
            approvalRequired: false
          }
        ]
      }),
      agents: [createAgent()],
      actor: {
        userId: 'user-operator',
        role: 'operator',
        permissions: capabilitiesToPermissions([
          'read_workspace_data',
          'create_sessions',
          'create_read_only_runs'
        ])
      },
      approvedContextGrants: ['audit_events']
    });

    assert.deepEqual(compiled.mcpServers, ['audit-log']);
    assert.deepEqual(compiled.tools, ['audit.events.search', 'mcp.tools.list']);
    assert.deepEqual(compiled.enabledSkills, ['acornops-security-baseline']);
    assert.deepEqual(compiled.contextGrants, ['audit_events']);
  });

  it('rejects workflow steps scoped to disabled agents', () => {
    assert.throws(
      () => compileWorkflowAccessScope({
        workflow: createWorkflow({
          steps: [
            {
              id: 'summarize',
              title: 'Summarize exposure',
              requiredInputs: [],
              agentIds: ['agent-disabled'],
              enabledSkills: ['acornops-security-baseline'],
              allowedMcpServers: ['audit-log'],
              allowedTools: ['audit.events.search'],
              contextGrants: ['audit_events'],
              approvalRequired: false
            }
          ]
        }),
        agents: [createAgent({ id: 'agent-disabled', status: 'disabled' })],
        actor: {
          userId: 'user-operator',
          role: 'operator',
          permissions: capabilitiesToPermissions([
            'read_workspace_data',
            'create_sessions',
            'create_read_only_runs'
          ])
        },
        approvedContextGrants: ['audit_events']
      }),
      (err) => err instanceof WorkflowAccessDeniedError
        && err.code === 'WORKFLOW_AGENT_SCOPE_DENIED'
    );
  });
});
