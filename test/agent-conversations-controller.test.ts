import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  changeAgentConversationAccess,
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  postAgentConversationMessage
} from '../src/controllers/agent-conversations-controller.js';
import { createAgent, deleteAgent, updateAgent } from '../src/controllers/agents-controller.js';
import { bootstrap } from '../src/controllers/internal-execution-controller.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import {
  callController,
  createWorkspaceAiCredentialStatusResponse,
  createRequest,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  installWorkspace('admin');
});

afterEach(() => {
  mock.restoreAll();
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('Agent conversations controller', () => {
  it('follows the Agent write policy at creation, allows workspace reads, and restricts continuation to the creator', async () => {
    const createdAgent = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Manual incident analyst',
        instructions: 'Inspect only the evidence supplied in this conversation.',
        status: 'active',
        reviewState: 'reviewed'
      }
    ));
    assert.equal(createdAgent.statusCode, 201);
    const agent = (createdAgent.body as {
      agent: { id: string; readiness: { status: string } };
    }).agent;
    assert.equal(agent.readiness.status, 'ready');
    const workflowCountsBefore = await db.query<{ definitions: string; sessions: string }>(
      `SELECT
         (SELECT COUNT(*) FROM workflow_definitions)::text AS definitions,
         (SELECT COUNT(*) FROM workflow_sessions)::text AS sessions`
    );

    const created = await callController(createAgentConversation, createRequest({
      workspaceId: 'workspace-1',
      agentId: agent.id
    }));
    assert.equal(created.statusCode, 201);
    const conversation = (created.body as {
      conversation: {
        id: string;
        createdBy: string;
        accessMode: string;
        permissionMode: string;
      };
    }).conversation;
    assert.equal(conversation.createdBy, 'user-1');
    assert.equal(conversation.accessMode, 'read_write');
    assert.equal(conversation.permissionMode, 'ask_before_changes');

    const listed = await callController(listAgentConversations, createRequest({
      workspaceId: 'workspace-1',
      agentId: agent.id
    }));
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      (listed.body as { items: Array<{ id: string }> }).items.map((item) => item.id),
      [conversation.id]
    );

    const readerRequest = createRequest({ conversationId: conversation.id });
    readerRequest.auth.userId = 'user-2';
    const readable = await callController(getAgentConversation, readerRequest);
    assert.equal(readable.statusCode, 200);

    const readerMessageRequest = createRequest(
      { conversationId: conversation.id },
      { content: 'Continue this conversation.' }
    );
    readerMessageRequest.auth.userId = 'user-2';
    const deniedMessage = await callController(postAgentConversationMessage, readerMessageRequest);
    assert.equal(deniedMessage.statusCode, 403);
    assert.equal(
      (deniedMessage.body as { error: { code: string } }).error.code,
      'AGENT_CONVERSATION_NOT_OWNED'
    );

    const readerAccessRequest = createRequest(
      { conversationId: conversation.id },
      { accessMode: 'read_write' }
    );
    readerAccessRequest.auth.userId = 'user-2';
    const deniedAccess = await callController(changeAgentConversationAccess, readerAccessRequest);
    assert.equal(deniedAccess.statusCode, 403);

    const downgraded = await callController(changeAgentConversationAccess, createRequest(
      { conversationId: conversation.id },
      { accessMode: 'read_only' }
    ));
    assert.equal(downgraded.statusCode, 200);
    assert.equal(
      (downgraded.body as { conversation: { accessMode: string } }).conversation.accessMode,
      'read_only'
    );

    const persisted = await db.query<{
      conversation_kind: string;
      target_id: string | null;
      agent_id: string | null;
    }>(
      'SELECT conversation_kind,target_id,agent_id FROM sessions WHERE id=$1',
      [conversation.id]
    );
    assert.deepEqual(persisted.rows[0], {
      conversation_kind: 'agent_chat',
      target_id: null,
      agent_id: agent.id
    });

    mock.method(globalThis, 'fetch', async (input, init) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return Response.json(createWorkspaceAiCredentialStatusResponse());
      }
      if (String(input) === `${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs` && init?.method === 'POST') {
        return new Response(null, { status: 202 });
      }
      return new Response(`unexpected request: ${String(input)}`, { status: 500 });
    });
    const accepted = await callController(postAgentConversationMessage, createRequest(
      { conversationId: conversation.id },
      { content: 'Summarize the evidence.', clientRequestId: randomUUID() }
    ));
    assert.equal(accepted.statusCode, 202);
    const acceptedRunId = (accepted.body as { run_id: string }).run_id;
    const runRecord = await db.query<{
      conversation_kind: string;
      target_id: string | null;
      agent_id: string;
      agent_snapshot: Record<string, unknown>;
      compiled_access_scope: Record<string, unknown>;
    }>('SELECT * FROM runs WHERE id=$1', [acceptedRunId]);
    assert.equal(runRecord.rows[0].conversation_kind, 'agent_chat');
    assert.equal(runRecord.rows[0].target_id, null);
    assert.equal(runRecord.rows[0].agent_id, agent.id);
    assert.equal(typeof runRecord.rows[0].agent_snapshot, 'object');
    assert.equal(typeof runRecord.rows[0].compiled_access_scope, 'object');
    assert.equal('selectedAgents' in runRecord.rows[0].compiled_access_scope, false);
    assert.equal('executor' in runRecord.rows[0].compiled_access_scope, false);
    await assert.rejects(
      db.query(
        `UPDATE runs
         SET compiled_access_scope=compiled_access_scope || '{"workflowId": "workflow-1"}'::jsonb
         WHERE id=$1`,
        [acceptedRunId]
      ),
      /runs_conversation_binding_check/
    );

    const activeDelete = await callController(deleteAgent, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(activeDelete.statusCode, 409);
    assert.equal(
      (activeDelete.body as { error: { code: string } }).error.code,
      'AGENT_HAS_ACTIVE_CONVERSATIONS'
    );

    const bootstrapped = await callController(bootstrap, createRequest({ runId: acceptedRunId }));
    assert.equal(bootstrapped.statusCode, 200);
    const bootstrapBody = bootstrapped.body as {
      scope: Record<string, unknown>;
      routing: Record<string, unknown>;
    };
    const bootstrapScope = bootstrapBody.scope;
    assert.equal(bootstrapScope.type, 'agent_chat');
    assert.equal(bootstrapScope.agent_id, agent.id);
    assert.equal(bootstrapScope.target_id, undefined);
    assert.equal(bootstrapScope.workflow_id, undefined);
    assert.deepEqual(bootstrapBody.routing, { agent_scoped: true });

    const updatedAgentResponse = await callController(updateAgent, createRequest(
      { agentId: agent.id },
      {
        workspaceId: 'workspace-1',
        instructions: 'Use the latest reviewed evidence and identify uncertainty.'
      }
    ));
    assert.equal(updatedAgentResponse.statusCode, 200);
    const updatedAgent = (updatedAgentResponse.body as {
      agent: { instructions: string };
    }).agent;

    const secondClientRequestId = randomUUID();
    const secondAccepted = await callController(postAgentConversationMessage, createRequest(
      { conversationId: conversation.id },
      { content: 'Re-evaluate with the latest Agent.', clientRequestId: secondClientRequestId }
    ));
    assert.equal(secondAccepted.statusCode, 202);
    const secondRunId = (secondAccepted.body as { run_id: string }).run_id;
    const secondRun = await db.query<{
      agent_snapshot: { instructions: string };
    }>('SELECT agent_snapshot FROM runs WHERE id=$1', [secondRunId]);
    assert.equal(secondRun.rows[0].agent_snapshot.instructions, updatedAgent.instructions);

    const repeated = await callController(postAgentConversationMessage, createRequest(
      { conversationId: conversation.id },
      { content: 'Re-evaluate with the latest Agent.', clientRequestId: secondClientRequestId }
    ));
    assert.equal(repeated.statusCode, 202);
    assert.equal((repeated.body as { run_id: string }).run_id, secondRunId);
    const workflowCountsAfter = await db.query<{ definitions: string; sessions: string }>(
      `SELECT
         (SELECT COUNT(*) FROM workflow_definitions)::text AS definitions,
         (SELECT COUNT(*) FROM workflow_sessions)::text AS sessions`
    );
    assert.deepEqual(workflowCountsAfter.rows[0], workflowCountsBefore.rows[0]);

    const activeConversationDelete = await callController(deleteAgentConversation, createRequest({
      conversationId: conversation.id
    }));
    assert.equal(activeConversationDelete.statusCode, 409);
    assert.equal(
      (activeConversationDelete.body as { error: { code: string } }).error.code,
      'AGENT_CONVERSATION_RUN_ACTIVE'
    );
    await db.query(
      `UPDATE runs SET status='completed',ended_at=NOW()
       WHERE session_id=$1 AND conversation_kind='agent_chat'`,
      [conversation.id]
    );
    const deleted = await callController(deleteAgentConversation, createRequest({
      conversationId: conversation.id
    }));
    assert.equal(deleted.statusCode, 204);
    const missing = await callController(getAgentConversation, createRequest({
      conversationId: conversation.id
    }));
    assert.equal(missing.statusCode, 404);
  });

  it('keeps read-only Agent policy as a hard ceiling', async () => {
    const createdAgent = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Read-only incident analyst',
        instructions: 'Inspect evidence without making changes.',
        status: 'active',
        reviewState: 'reviewed',
        permissionMode: 'read_only'
      }
    ));
    assert.equal(createdAgent.statusCode, 201);
    const agent = (createdAgent.body as { agent: { id: string } }).agent;

    const created = await callController(createAgentConversation, createRequest({
      workspaceId: 'workspace-1',
      agentId: agent.id
    }));
    assert.equal(created.statusCode, 201);
    const conversation = (created.body as {
      conversation: { id: string; accessMode: string };
    }).conversation;
    assert.equal(conversation.accessMode, 'read_only');

    const elevated = await callController(changeAgentConversationAccess, createRequest(
      { conversationId: conversation.id },
      { accessMode: 'read_write' }
    ));
    assert.equal(elevated.statusCode, 409);
    assert.equal(
      (elevated.body as { error: { code: string } }).error.code,
      'AGENT_CONVERSATION_POLICY_READ_ONLY'
    );

    const invalidId = await callController(postAgentConversationMessage, createRequest(
      { conversationId: conversation.id },
      { content: 'Inspect.', clientRequestId: ' '.repeat(2) }
    ));
    assert.equal(invalidId.statusCode, 400);
    assert.equal(
      (invalidId.body as { error: { code: string } }).error.code,
      'AGENT_CONVERSATION_CLIENT_REQUEST_ID_INVALID'
    );
  });

  it('falls back to read-only when the creator lacks write-run permission', async () => {
    const createdAgent = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Approval-gated incident analyst',
        instructions: 'Ask before making changes.',
        status: 'active',
        reviewState: 'reviewed',
        permissionMode: 'ask_before_changes'
      }
    ));
    assert.equal(createdAgent.statusCode, 201);
    const agent = (createdAgent.body as { agent: { id: string } }).agent;

    installWorkspace('operator');
    const created = await callController(createAgentConversation, createRequest({
      workspaceId: 'workspace-1',
      agentId: agent.id
    }));
    assert.equal(created.statusCode, 201);
    assert.equal(
      (created.body as { conversation: { accessMode: string } }).conversation.accessMode,
      'read_only'
    );
  });

  it('allows direct chat in a workspace with no targets', async () => {
    const createdAgent = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Target-aware analyst',
        instructions: 'Help with general analysis and use target evidence only when available.',
        status: 'active',
        reviewState: 'reviewed',
        semanticCapabilityIds: ['infrastructure.diagnostics.read']
      }
    ));
    assert.equal(createdAgent.statusCode, 201);
    const agent = (createdAgent.body as {
      agent: { id: string; readiness: { status: string } };
    }).agent;
    assert.equal(agent.readiness.status, 'ready');

    const created = await callController(createAgentConversation, createRequest({
      workspaceId: 'workspace-1',
      agentId: agent.id
    }));
    assert.equal(created.statusCode, 201);
  });
});
