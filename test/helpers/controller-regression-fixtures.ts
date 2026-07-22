import { mock } from 'node:test';
import { repo } from '../../src/store/repository.js';
import { configureWorkflowOptionsCatalogLoaderForTests } from '../../src/store/repository-workflow-options.js';
import { effectiveWorkflowRuntimePolicy } from '../../src/services/workflow-runtime-policy.js';
import type { WorkflowMcpServerRecord } from '../../src/store/repository-workflows.js';
import type {
  Role
} from '../../src/types/domain.js';
import { createCluster, createTarget } from './controller-regression-records.js';
export {
  createApproval,
  createCluster,
  createMessage,
  createRun,
  createSessionRecord,
  createTarget,
  createWebhookSubscription
} from './controller-regression-records.js';

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
  getRunRequestProvenance: repo.getRunRequestProvenance,
  upsertAssistantFinalMessage: repo.upsertAssistantFinalMessage,
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
  deleteWorkspace: repo.deleteWorkspace,
  getExternalIntegrationWorkspaceGrant: repo.getExternalIntegrationWorkspaceGrant,
  listExternalIntegrationGrantableWorkspaces: repo.listExternalIntegrationGrantableWorkspaces,
  replaceExternalIntegrationWorkspaceGrants: repo.replaceExternalIntegrationWorkspaceGrants
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
  id: 'acornops-target-agent', scope: 'workspace', name: 'Cluster agent', url: 'builtin://cluster-agent', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [
    { name: 'get_resource', title: 'Get resource', capability: 'read', enabled: true },
    { name: 'get_resource_logs', title: 'Get resource logs', capability: 'read', enabled: true },
    { name: 'list_resources', title: 'List resources', capability: 'read', enabled: true }
  ]
}, {
  id: 'workspace-chat', scope: 'workspace', name: 'Workspace chat', url: 'builtin://workspace-chat', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [{ name: 'prompt.resources.read', title: 'Read prompt resources', capability: 'read', enabled: true }]
}, {
  id: 'artifact-writer', scope: 'workspace', name: 'Artifact writer', url: 'builtin://artifacts', enabled: true,
  authType: 'none', credentialConfigured: false, publicHeaders: {}, status: 'connected', createdBy: 'test',
  tools: [{ name: 'reports.pdf.generate', title: 'Generate PDF', capability: 'write', enabled: true }]
}];

export function restoreControllerRegressionState(): void {
  configureWorkflowOptionsCatalogLoaderForTests();
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
  repo.getRunRequestProvenance = originals.getRunRequestProvenance;
  repo.upsertAssistantFinalMessage = originals.upsertAssistantFinalMessage;
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
  repo.getExternalIntegrationWorkspaceGrant = originals.getExternalIntegrationWorkspaceGrant;
  repo.listExternalIntegrationGrantableWorkspaces = originals.listExternalIntegrationGrantableWorkspaces;
  repo.replaceExternalIntegrationWorkspaceGrants = originals.replaceExternalIntegrationWorkspaceGrants;
  mock.restoreAll();
}
export function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    sent: false,
    headers: new Map<string, string>(),
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
    },
    setHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
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

export function createExternalIntegrationRequest(params: Record<string, string>, body: Record<string, unknown> = {}) {
  return {
    params,
    body,
    query: {},
    auth: {
      userId: 'user-1',
      credential: {
        type: 'external_integration' as const,
        linkId: 'link-1',
        integrationId: 'external-chat',
        provider: 'external',
        externalUserId: 'external-user-1'
      }
    }
  };
}

export async function callController(
  handler: (req: never, res: never, next: (err?: unknown) => void) => Promise<void>,
  req: ReturnType<typeof createRequest> | ReturnType<typeof createExternalIntegrationRequest>
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
  configureWorkflowOptionsCatalogLoaderForTests(async (_workspaceId) => {
    const servers = [...mcpServers.values()].filter((server) => server.id === 'acornops-target-agent');
    const runtimePolicy = effectiveWorkflowRuntimePolicy();
    return {
      mcpServers: servers.map((server) => ({ value: server.id, label: server.name, disabled: !server.enabled })),
      skills: [
        { value: 'acornops-observability', label: 'AcornOps observability' },
        { value: 'acornops-cross-repo-change', label: 'Cross-repo change' },
        { value: 'acornops-open-pr', label: 'Open PR' },
        { value: 'acornops-target-boundary-design', label: 'Target boundary design' }
      ],
      mcpTools: [
        ...servers.flatMap((server) => server.tools.map((tool) => ({
          value: tool.name, label: tool.title, disabled: !server.enabled || !tool.enabled
        }))),
        { value: 'prompt.resources.read', label: 'Read prompt resources' },
        { value: 'reports.pdf.generate', label: 'Generate incident report PDF' }
      ],
      agents: [],
      outputFormats: [{ value: 'pdf', label: 'PDF' }, { value: 'markdown', label: 'Markdown' }],
      approvalPolicies: [],
      runtimeLimits: [{ value: String(runtimePolicy.maxRuntimeSeconds), label: 'Deployment limit' }],
      retentionPolicies: [{ value: String(runtimePolicy.retentionDays), label: 'Deployment limit' }],
      sourceAvailability: {
        mcpServers: { status: 'available' }, mcpTools: { status: 'available' },
        skills: { status: 'available' }, agents: { status: 'available' }
      }
    };
  });
  repo.getWorkspaceRole = async () => role;
  repo.getExternalIntegrationWorkspaceGrant = async (_input) => role
    ? {
        workspaceId: 'workspace-1',
        capabilities: ['read_workspace_data', 'create_sessions', 'create_read_only_runs'],
        grantedByUserId: 'user-1',
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z'
      }
    : null;
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

export function isMcpReadinessRequest(input: unknown, init?: RequestInit): boolean {
  return String(input).endsWith('/api/v1/internal/mcp/connections/readiness')
    && init?.method === 'POST';
}

export function createReadyMcpReadinessResponse(): Response {
  return new Response(JSON.stringify({ ready: true, failures: [] }), { status: 200 });
}
