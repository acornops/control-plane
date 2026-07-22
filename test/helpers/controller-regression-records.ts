import type {
  ChatSession,
  Cluster,
  Message,
  Run,
  RunToolApproval,
  TargetSummary,
  WebhookSubscription
} from '../../src/types/domain.js';

export function createCluster(): Cluster {
  return {
    id: 'cluster-1', workspaceId: 'workspace-1', name: 'cluster', status: 'online',
    namespaceInclude: [], namespaceExclude: [],
    writeConfirmationPolicy: { effectiveRequired: false, overrideRequired: null, source: 'deployment_default' },
    createdAt: '2026-05-24T00:00:00.000Z', updatedAt: '2026-05-24T00:00:00.000Z'
  };
}

export function createTarget(overrides: Partial<TargetSummary> = {}): TargetSummary {
  return {
    id: 'cluster-1', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'cluster', status: 'online',
    metadata: {}, createdAt: '2026-05-24T00:00:00.000Z', updatedAt: '2026-05-24T00:00:00.000Z', ...overrides
  };
}

export function createSessionRecord(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1', workspaceId: 'workspace-1', targetId: 'cluster-1', targetType: 'kubernetes',
    clusterId: 'cluster-1', createdBy: 'user-1', title: 'Session', status: 'open',
    createdAt: '2026-05-24T00:00:00.000Z', updatedAt: '2026-05-24T00:00:00.000Z',
    lastMessageAt: '2026-05-24T00:00:00.000Z', expiresAt: '2026-05-25T00:00:00.000Z',
    ...overrides
  };
}

export function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1', workspaceId: 'workspace-1', targetId: 'cluster-1', targetType: 'kubernetes',
    clusterId: 'cluster-1', sessionId: 'session-1', messageId: 'message-1', llmProvider: 'gemini',
    llmModel: 'gemini-2.0-flash', llmReasoningSummaryMode: 'auto', llmReasoningEffort: 'low',
    principal: { type: 'user', id: 'user-1' }, toolAccessMode: 'read_write', status: 'completed',
    requestedAt: '2026-05-24T00:00:00.000Z', ...overrides
  };
}

export function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1', sessionId: 'session-1', runId: 'run-1', role: 'user', kind: 'user',
    content: 'diagnose', createdAt: '2026-05-24T00:00:00.000Z', ...overrides
  };
}

export function createApproval(overrides: Partial<RunToolApproval> = {}): RunToolApproval {
  return {
    id: 'approval-1', runId: 'run-1', workspaceId: 'workspace-1', clusterId: 'cluster-1',
    targetId: 'cluster-1', targetType: 'kubernetes', toolCallId: 'call-1', toolName: 'restart_workload',
    summary: 'Restart workload default/api.', arguments: {}, status: 'pending', executionStatus: 'not_started',
    requestedBy: 'requester-1', createdAt: '2026-05-24T00:00:00.000Z', updatedAt: '2026-05-24T00:00:00.000Z',
    expiresAt: '2026-05-25T00:00:00.000Z', ...overrides
  };
}

export function createWebhookSubscription(): WebhookSubscription {
  return {
    id: 'webhook-1', workspaceId: 'workspace-1', targetId: 'cluster-1', name: 'Webhook',
    url: 'https://example.test/webhook', eventTypes: ['run.created.v1'], enabled: true,
    secretCiphertext: 'ciphertext', secretKeyId: 'default', createdBy: 'user-1',
    createdAt: '2026-05-24T00:00:00.000Z', updatedAt: '2026-05-24T00:00:00.000Z'
  };
}
