import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import {
  changeAgentConversationAccess,
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  postAgentConversationMessage
} from '../src/controllers/agent-conversations-controller.js';
import { createAgent } from '../src/controllers/agents-controller.js';
import { createSession, getWorkflow, listWorkflows } from '../src/controllers/workflows-controller.js';
import {
  callController,
  createRequest,
  installWorkspace,
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
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('Agent conversations controller', () => {
  it('creates read-only conversations, allows workspace reads, and restricts continuation to the creator', async () => {
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
      agent: { id: string; version: number; readiness: { status: string } };
    }).agent;
    assert.equal(agent.readiness.status, 'ready');

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
        agentVersion: number;
      };
    }).conversation;
    assert.equal(conversation.createdBy, 'user-1');
    assert.equal(conversation.accessMode, 'read_only');
    assert.equal(conversation.agentVersion, agent.version);

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

    const elevated = await callController(changeAgentConversationAccess, createRequest(
      { conversationId: conversation.id },
      { accessMode: 'read_write' }
    ));
    assert.equal(elevated.statusCode, 200);
    assert.equal(
      (elevated.body as { conversation: { accessMode: string } }).conversation.accessMode,
      'read_write'
    );

    const carrierId = `agent-chat-${agent.id}`;
    const workflowCatalog = await callController(listWorkflows, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(workflowCatalog.statusCode, 200);
    assert.ok(!(workflowCatalog.body as { items: Array<{ id: string }> }).items.some((item) => item.id === carrierId));

    const directRead = await callController(getWorkflow, createRequest(
      { workflowId: carrierId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(directRead.statusCode, 404);
    const directSession = await callController(createSession, createRequest(
      { workflowId: carrierId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(directSession.statusCode, 404);

    const deleted = await callController(deleteAgentConversation, createRequest({
      conversationId: conversation.id
    }));
    assert.equal(deleted.statusCode, 204);
    const missing = await callController(getAgentConversation, createRequest({
      conversationId: conversation.id
    }));
    assert.equal(missing.statusCode, 404);
  });
});
