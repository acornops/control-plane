import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { callMcpTool, operationForToolCall } from '../src/controllers/internal-mcp-bridge-controller.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { repo } from '../src/store/repository.js';
import {
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  getWorkflowDefinition,
  resetWorkflowRepositoryForTests,
  updateWorkflowRun
} from '../src/store/repository-workflows.js';

afterEach(() => {
  resetWorkflowRepositoryForTests();
});

function createResponseWithClaims(claims: Record<string, unknown>) {
  return {
    statusCode: 200,
    body: undefined as unknown,
    locals: {
      gatewayRunClaims: claims
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

async function callMcpBridge(claims: Record<string, unknown>, body: Record<string, unknown>) {
  const res = createResponseWithClaims(claims);
  await callMcpTool({ body } as never, res as never, (err?: unknown) => {
    if (err) throw err;
  });
  return res;
}

describe('internal MCP bridge audit classification', () => {
  it('uses token tool-operation metadata and defaults unknown tools to write', () => {
    assert.equal(
      operationForToolCall({ allowedToolOperations: { get_resource: 'read', restart_workload: 'write' } }, 'get_resource'),
      'read'
    );
    assert.equal(
      operationForToolCall({ allowedToolOperations: { get_resource: 'read', restart_workload: 'write' } }, 'restart_workload'),
      'write'
    );
    assert.equal(operationForToolCall({ allowedToolOperations: {} }, 'unknown_tool'), 'write');
  });

  it('executes workspace workflow tools from the server-compiled run scope without a target', async () => {
    const workflow = getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const message = createWorkflowUserMessage({ session, content: 'Triage cluster', inputs: { clusterId: 'cluster-primary' } });
    const run = updateWorkflowRun(
      createWorkflowRun({ session, message, workflowStepId: 'collect-cluster-signals' }).id,
      { status: 'running' }
    );
    assert.ok(run);

    let auditOperation = '';
    let auditMetadata: Record<string, unknown> = {};
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditOperation = event.operation;
      auditMetadata = event.metadata || {};
      return null;
    };

    const response = await callMcpBridge(
      {
        runId: run.id,
        workspaceId: run.workspaceId,
        sessionId: run.workflowSessionId,
        scopeType: 'workspace',
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: run.workflowSessionId,
        workflowStepId: run.workflowStepId,
        allowedTools: ['metrics.query'],
        allowedToolOperations: { 'metrics.query': 'read' },
        contextGrants: run.compiledAccessScope.contextGrants
      },
      { name: 'metrics.query', arguments: {} }
    );

    assert.equal(response.statusCode, 200);
    const content = (response.body as { content: Array<{ text: string }>; isError: boolean }).content;
    const payload = JSON.parse(content[0].text) as { tool: string; workflowId: string; scopeType: string };
    assert.equal((response.body as { isError: boolean }).isError, false);
    assert.equal(payload.scopeType, 'workspace');
    assert.equal(payload.workflowId, 'cluster-triage');
    assert.equal(payload.tool, 'metrics.query');
    assert.equal(auditOperation, 'read');
    assert.equal(auditMetadata.source, 'workflow_mcp_bridge');
    assert.equal(auditMetadata.workflowRunId, run.workflowRunId);
  });
});
