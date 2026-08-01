import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { directWorkflowAttachments } from '../../src/services/workflow-capability-preview.js';
import type { AgentDefinition } from '../../src/types/agents.js';
import type { CompiledWorkflowAccessScope } from '../../src/types/workflows.js';

describe('Workflow direct attachment preview', () => {
  it('derives only exact Agent-owned MCP, native-tool, and skill attachments', () => {
    const agent = {
      mcpInstallations: [{
        id: 'server-1',
        name: 'Records',
        enabled: true,
        tools: [{
          serverId: 'server-1', toolName: 'records.list', alias: 'records_list',
          description: 'List records.', capability: 'read', enabled: true,
          reviewState: 'approved'
        }, {
          serverId: 'server-1', toolName: 'records.write', alias: 'records_write',
          capability: 'write', enabled: true, reviewState: 'pending'
        }]
      }],
      skillInstallations: [{ id: 'skill-1', name: 'Audit records' }]
    } as unknown as AgentDefinition;
    const scope = {
      mcpServers: ['server-1'],
      mcpTools: [{ serverId: 'server-1', toolName: 'records.list' }],
      tools: ['records_list', 'workspace.metadata.read', 'target_status'],
      toolOperations: {
        records_list: 'read',
        'workspace.metadata.read': 'read',
        target_status: 'read'
      },
      enabledSkills: ['skill-1']
    } as unknown as CompiledWorkflowAccessScope;

    assert.deepEqual(directWorkflowAttachments({
      agent,
      scope,
      excludedToolNames: ['target_status']
    }), {
      tools: [{
        id: 'records_list', name: 'records_list', label: 'records.list',
        description: 'List records.', access: 'read', source: 'mcp', serverId: 'server-1'
      }, {
        id: 'workspace.metadata.read', name: 'workspace.metadata.read',
        label: 'workspace.metadata.read', access: 'read', source: 'builtin'
      }],
      mcpServers: [{ id: 'server-1', name: 'Records' }],
      skills: [{ id: 'skill-1', name: 'Audit records' }]
    });
  });
});
