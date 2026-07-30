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
        permissionMode: string;
      };
    }).conversation;
    assert.equal(conversation.createdBy, 'user-1');
    assert.equal(conversation.accessMode, 'read_write');
    assert.equal(conversation.agentVersion, agent.version);
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
});
