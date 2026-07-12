import { mock } from 'node:test';
import { repo } from '../../src/store/repository.js';
import { defaultAgentDefinitions } from '../../src/store/repository-agents.js';
import { configureWorkflowMcpRepositoryForTests } from '../../src/store/repository-workflow-mcp.js';
import { configureWorkflowOptionsCatalogLoaderForTests } from '../../src/store/repository-workflow-options.js';
import type { WorkflowMcpServerRecord } from '../../src/store/repository-workflows.js';
import type {
  ChatSession,
  Cluster,
  Message,
  Role,
  Run,
  RunToolApproval,
  TargetSummary,
  WebhookSubscription
} from '../../src/types/domain.js';

const originals = {
  getWorkspaceSummaryForUser: repo.getWorkspaceSummaryForUser,
  getWorkspaceRole: repo.getWorkspaceRole,
  getCluster: repo.getCluster,
  getTarget: repo.getTarget,
  listTargets: repo.listTargets,
  addSession: repo.addSession,
  listRecentTargetChatActivity: repo.listRecentTargetChatActivity,
  listTargetChatActivityEvents: repo.listTargetChatActivityEvents,
  getSession: repo.getSession,
  listMessages: repo.listMessages,
  deleteSession: repo.deleteSession,
  getWorkspaceAiSettings: repo.getWorkspaceAiSettings,
  upsertWorkspaceAiSettings: repo.upsertWorkspaceAiSettings,
  findRunByClientMessageId: repo.findRunByClientMessageId,
  createRunFromUserMessage: repo.createRunFromUserMessage,
  getRun: repo.getRun,
  createRunToolApproval: repo.createRunToolApproval,
  getRunToolApproval: repo.getRunToolApproval,
  listWorkspaceRunToolApprovals: repo.listWorkspaceRunToolApprovals,
  countPendingWorkspaceRunToolApprovals: repo.countPendingWorkspaceRunToolApprovals,
  decideRunToolApproval: repo.decideRunToolApproval,
  getRunContinuation: repo.getRunContinuation,
  appendRunEvents: repo.appendRunEvents,
  getLatestRunEventSeq: repo.getLatestRunEventSeq,
  insertTargetChatActivityEvent: repo.insertTargetChatActivityEvent,
  expireRunToolApproval: repo.expireRunToolApproval,
  deleteRunContinuation: repo.deleteRunContinuation,
  updateRun: repo.updateRun,
  getTargetAgentRegistration: repo.getTargetAgentRegistration,
  rotateTargetAgentKey: repo.rotateTargetAgentKey,
  upsertTargetAgentRegistration: repo.upsertTargetAgentRegistration,
  insertWorkspaceAuditEvent: repo.insertWorkspaceAuditEvent,
  listMatchingWebhookSubscriptions: repo.listMatchingWebhookSubscriptions,
  listTargetToolOverrides: repo.listTargetToolOverrides,
  setTargetToolOverride: repo.setTargetToolOverride,
  getTargetToolSetting: repo.getTargetToolSetting,
  listEnabledTargetToolSettings: repo.listEnabledTargetToolSettings,
  upsertTargetToolSetting: repo.upsertTargetToolSetting,
  searchTargetInsightsSnippets: repo.searchTargetInsightsSnippets,
  requeueTargetInsightsPausedCheckpoints: repo.requeueTargetInsightsPausedCheckpoints,
  listEnabledValidTargetSkills: repo.listEnabledValidTargetSkills,
  listEnabledValidTargetSkillSummaries: repo.listEnabledValidTargetSkillSummaries,
  createWebhookSubscription: repo.createWebhookSubscription,
  updateWebhookSubscription: repo.updateWebhookSubscription,
  deleteWebhookSubscription: repo.deleteWebhookSubscription,
  deleteWorkspace: repo.deleteWorkspace
};

const canonicalWorkflowMcpServers: Array<Omit<WorkflowMcpServerRecord, 'workspaceId' | 'createdAt'>> = [{
  id: 'github', scope: 'workspace', name: 'Test repository MCP', url: 'https://mcp.example.test', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [
    { name: 'github.repositories.read', title: 'Read repositories', capability: 'read', enabled: true },
    { name: 'github.branches.list', title: 'List branches', capability: 'read', enabled: true },
    { name: 'github.prs.list', title: 'List pull requests', capability: 'read', enabled: true },
    { name: 'github.branches.create', title: 'Create branches', capability: 'write', enabled: true },
    { name: 'github.prs.create', title: 'Create pull requests', capability: 'write', enabled: true }
  ]
}, {
  id: 'acornops-cluster-agent', scope: 'workspace', name: 'Cluster agent', url: 'builtin://cluster-agent', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [
    { name: 'inventory.resources.list', title: 'List resources', capability: 'read', enabled: true }, { name: 'events.search', title: 'Search events', capability: 'read', enabled: true },
    { name: 'logs.summarize', title: 'Summarize logs', capability: 'read', enabled: true }, { name: 'metrics.query', title: 'Query metrics', capability: 'read', enabled: true }
  ]
}, {
  id: 'workspace-chat', scope: 'workspace', name: 'Workspace chat', url: 'builtin://workspace-chat', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [{ name: 'chat.sessions.read_selected', title: 'Read selected chats', capability: 'read', enabled: true }]
}, {
  id: 'artifact-writer', scope: 'workspace', name: 'Artifact writer', url: 'builtin://artifacts', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [{ name: 'reports.pdf.generate', title: 'Generate PDF', capability: 'write', enabled: true }]
}];

export function restoreControllerRegressionState(): void {
  configureWorkflowOptionsCatalogLoaderForTests();
  configureWorkflowMcpRepositoryForTests();
  repo.getWorkspaceSummaryForUser = originals.getWorkspaceSummaryForUser;
  repo.getWorkspaceRole = originals.getWorkspaceRole;
  repo.getCluster = originals.getCluster;
  repo.getTarget = originals.getTarget;
  repo.listTargets = originals.listTargets;
  repo.addSession = originals.addSession;
  repo.listRecentTargetChatActivity = originals.listRecentTargetChatActivity;
  repo.listTargetChatActivityEvents = originals.listTargetChatActivityEvents;
  repo.getSession = originals.getSession;
  repo.listMessages = originals.listMessages;
  repo.deleteSession = originals.deleteSession;
  repo.getWorkspaceAiSettings = originals.getWorkspaceAiSettings;
  repo.upsertWorkspaceAiSettings = originals.upsertWorkspaceAiSettings;
  repo.findRunByClientMessageId = originals.findRunByClientMessageId;
  repo.createRunFromUserMessage = originals.createRunFromUserMessage;
  repo.getRun = originals.getRun;
  repo.createRunToolApproval = originals.createRunToolApproval;
  repo.getRunToolApproval = originals.getRunToolApproval;
  repo.listWorkspaceRunToolApprovals = originals.listWorkspaceRunToolApprovals;
  repo.countPendingWorkspaceRunToolApprovals = originals.countPendingWorkspaceRunToolApprovals;
  repo.decideRunToolApproval = originals.decideRunToolApproval;
  repo.getRunContinuation = originals.getRunContinuation;
  repo.appendRunEvents = originals.appendRunEvents;
  repo.getLatestRunEventSeq = originals.getLatestRunEventSeq;
  repo.insertTargetChatActivityEvent = originals.insertTargetChatActivityEvent;
  repo.expireRunToolApproval = originals.expireRunToolApproval;
  repo.deleteRunContinuation = originals.deleteRunContinuation;
  repo.updateRun = originals.updateRun;
  repo.getTargetAgentRegistration = originals.getTargetAgentRegistration;
  repo.rotateTargetAgentKey = originals.rotateTargetAgentKey;
  repo.upsertTargetAgentRegistration = originals.upsertTargetAgentRegistration;
  repo.insertWorkspaceAuditEvent = originals.insertWorkspaceAuditEvent;
  repo.listMatchingWebhookSubscriptions = originals.listMatchingWebhookSubscriptions;
  repo.listTargetToolOverrides = originals.listTargetToolOverrides;
  repo.setTargetToolOverride = originals.setTargetToolOverride;
  repo.getTargetToolSetting = originals.getTargetToolSetting;
  repo.listEnabledTargetToolSettings = originals.listEnabledTargetToolSettings;
  repo.upsertTargetToolSetting = originals.upsertTargetToolSetting;
  repo.searchTargetInsightsSnippets = originals.searchTargetInsightsSnippets;
  repo.requeueTargetInsightsPausedCheckpoints = originals.requeueTargetInsightsPausedCheckpoints;
  repo.listEnabledValidTargetSkills = originals.listEnabledValidTargetSkills;
  repo.listEnabledValidTargetSkillSummaries = originals.listEnabledValidTargetSkillSummaries;
  repo.createWebhookSubscription = originals.createWebhookSubscription;
  repo.updateWebhookSubscription = originals.updateWebhookSubscription;
  repo.deleteWebhookSubscription = originals.deleteWebhookSubscription;
  repo.deleteWorkspace = originals.deleteWorkspace;
  mock.restoreAll();
}

export function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    sent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload?: unknown) {
      this.sent = true;
      this.body = payload;
      return this;
    }
  };
}

export function createRequest(params: Record<string, string>, body: Record<string, unknown> = {}) {
  return {
    params,
    body,
    query: {},
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    }
  };
}

export async function callController(
  handler: (req: never, res: never, next: (err?: unknown) => void) => Promise<void>,
  req: ReturnType<typeof createRequest>
) {
  const res = createResponse();
  await handler(req as never, res as never, (err?: unknown) => {
    if (err) throw err;
  });
  return res;
}

export function installWorkspace(role: Role | null): void {
  const now = '2026-05-24T00:00:00.000Z';
  const mcpServers = new Map<string, WorkflowMcpServerRecord>(canonicalWorkflowMcpServers.map((server) => [server.id, {
    ...server,
    workspaceId: 'workspace-1',
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    publicHeaders: { ...server.publicHeaders },
    tools: server.tools.map((tool) => ({ ...tool }))
  }]));
  configureWorkflowMcpRepositoryForTests({
    list: async () => [...mcpServers.values()],
    create: async (workspaceId, input) => {
      const id = `server-${mcpServers.size + 1}`;
      const server: WorkflowMcpServerRecord = {
        id, workspaceId, scope: 'workspace', name: input.name, url: input.url, enabled: input.enabled !== false,
        authType: input.auth?.type || 'none', publicHeaders: input.publicHeaders || {},
        credentialConfigured: Boolean(input.auth?.credential),
        status: input.enabled === false ? 'disabled' : 'not_checked', tools: [],
        createdBy: input.createdBy, createdAt: now, updatedAt: now
      };
      mcpServers.set(id, server);
      return server;
    },
    update: async (_workspaceId, serverId, patch) => {
      const current = mcpServers.get(serverId);
      if (!current) return null;
      const updated = {
        ...current,
        name: patch.name || current.name,
        url: patch.url || current.url,
        enabled: patch.enabled ?? current.enabled,
        status: patch.enabled === false ? 'disabled' as const : current.status,
        authType: patch.auth?.type || current.authType,
        publicHeaders: patch.publicHeaders || current.publicHeaders,
        updatedAt: now
      };
      mcpServers.set(serverId, updated);
      return updated;
    },
    delete: async (_workspaceId, serverId) => mcpServers.delete(serverId),
    test: async (_workspaceId, serverId) => {
      const current = mcpServers.get(serverId);
      if (!current) return null;
      const updated = { ...current, status: current.enabled ? 'connected' as const : 'disabled' as const, lastCheckedAt: now };
      mcpServers.set(serverId, updated);
      return updated;
    },
    tools: async (_workspaceId, serverId) => mcpServers.get(serverId)?.tools || null
  });
  configureWorkflowOptionsCatalogLoaderForTests(async (workspaceId) => {
    const agents = defaultAgentDefinitions(workspaceId).filter((agent) => agent.kind === 'specialist_agent');
    const servers = [...mcpServers.values()];
    return {
      clusters: [],
      mcpServers: servers.map((server) => ({ value: server.id, label: server.name, disabled: !server.enabled })),
      mcpTools: servers.flatMap((server) => server.tools.map((tool) => ({
        value: tool.name, label: tool.title, disabled: !server.enabled || !tool.enabled
      }))),
      skills: [
        { value: 'acornops-observability', label: 'AcornOps observability' },
        { value: 'acornops-cross-repo-change', label: 'Cross-repo change' },
        { value: 'acornops-open-pr', label: 'Open PR' },
        { value: 'acornops-target-boundary-design', label: 'Target boundary design' }
      ],
      agents: agents.map((agent) => ({ value: agent.id, label: agent.name })),
      chatSessions: [],
      outputFormats: [{ value: 'pdf', label: 'PDF' }, { value: 'markdown', label: 'Markdown' }],
      approvalPolicies: [],
      runtimeLimits: [],
      retentionPolicies: [],
      sourceAvailability: {
        clusters: { status: 'empty' },
        mcpServers: { status: 'available' }, mcpTools: { status: 'available' },
        skills: { status: 'available' }, agents: { status: 'available' }, chatSessions: { status: 'empty' }
      }
    };
  });
  repo.getWorkspaceRole = async () => role;
  repo.getCluster = async (clusterId: string) => clusterId === 'cluster-1' ? createCluster() : null;
  repo.getTarget = async (_workspaceId: string, targetId: string) => {
    if (targetId === 'cluster-1') return createTarget({ id: 'cluster-1', name: 'cluster', targetType: 'kubernetes' });
    if (targetId === 'target-1') return createTarget({ id: 'target-1', name: 'vm', targetType: 'virtual_machine' });
    return null;
  };
  repo.listMatchingWebhookSubscriptions = async () => [];
  repo.insertWorkspaceAuditEvent = async (event) => ({
    id: 'audit-event-1',
    workspaceId: event.workspaceId,
    category: event.category,
    eventType: event.eventType,
    actor: {
      type: event.actorType || (event.actorUserId ? 'user' : 'system'),
      ...(event.actorUserId ? { userId: event.actorUserId } : {})
    },
    object: {
      type: event.objectType,
      ...(event.objectId ? { id: event.objectId } : {}),
      ...(event.objectName ? { name: event.objectName } : {})
    },
    summary: event.summary,
    metadata: event.metadata ?? {},
    occurredAt: '2026-05-24T00:00:00.000Z'
  });
  repo.insertTargetChatActivityEvent = async (event) => ({
    id: 'activity-event-1',
    workspaceId: event.workspaceId,
    targetId: event.targetId,
    targetType: event.targetType,
    sessionId: event.sessionId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    type: event.type,
    payload: event.payload ?? {},
    createdAt: '2026-05-24T00:00:00.000Z'
  });
  repo.getWorkspaceAiSettings = async () => null;
  repo.requeueTargetInsightsPausedCheckpoints = async () => 0;
  repo.listEnabledValidTargetSkills = async () => [];
  repo.listEnabledValidTargetSkillSummaries = async () => [];
}

export function createWorkspaceAiCredentialStatusResponse(workspaceId = 'workspace-1') {
  return {
    workspace_id: workspaceId,
    providers: [
      { provider: 'openai', configured: true, enabled: true },
      { provider: 'anthropic', configured: true, enabled: true },
      { provider: 'gemini', configured: true, enabled: true }
    ]
  };
}

export function isWorkspaceAiCredentialStatusRequest(input: unknown): boolean {
  return String(input).includes('/api/v1/internal/llm/provider-credentials?');
}

export function createCluster(): Cluster {
  return {
    id: 'cluster-1',
    workspaceId: 'workspace-1',
    name: 'cluster',
    status: 'online',
    namespaceInclude: [],
    namespaceExclude: [],
    writeConfirmationPolicy: {
      effectiveRequired: false,
      overrideRequired: null,
      source: 'deployment_default'
    },
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z'
  };
}

export function createTarget(overrides: Partial<TargetSummary> = {}): TargetSummary {
  return {
    id: 'cluster-1',
    workspaceId: 'workspace-1',
    targetType: 'kubernetes',
    name: 'cluster',
    status: 'online',
    metadata: {},
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    ...overrides
  };
}

export function createSessionRecord(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    createdBy: 'user-1',
    title: 'Session',
    status: 'open',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    lastMessageAt: '2026-05-24T00:00:00.000Z',
    expiresAt: '2026-05-25T00:00:00.000Z',
    ...overrides
  };
}

export function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    llmProvider: 'gemini',
    llmModel: 'gemini-2.0-flash',
    toolAccessMode: 'read_write',
    status: 'completed',
    requestedAt: '2026-05-24T00:00:00.000Z',
    ...overrides
  };
}

export function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    runId: 'run-1',
    role: 'user',
    kind: 'user',
    content: 'diagnose',
    createdAt: '2026-05-24T00:00:00.000Z',
    ...overrides
  };
}

export function createApproval(overrides: Partial<RunToolApproval> = {}): RunToolApproval {
  return {
    id: 'approval-1',
    runId: 'run-1',
    workspaceId: 'workspace-1',
    clusterId: 'cluster-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    toolCallId: 'call-1',
    toolName: 'restart_workload',
    summary: 'Restart workload default/api.',
    arguments: {},
    status: 'pending',
    executionStatus: 'not_started',
    requestedBy: 'requester-1',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
    expiresAt: '2026-05-25T00:00:00.000Z',
    ...overrides
  };
}

export function createWebhookSubscription(): WebhookSubscription {
  return {
    id: 'webhook-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    name: 'Webhook',
    url: 'https://example.test/webhook',
    eventTypes: ['run.created.v1'],
    enabled: true,
    secretCiphertext: 'ciphertext',
    secretKeyId: 'default',
    createdBy: 'user-1',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z'
  };
}
