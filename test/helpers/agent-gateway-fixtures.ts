import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { mock } from 'node:test';
import WebSocket from 'ws';
import {
  AgentGateway,
  resetAgentGatewayStateForTests,
  setBuiltInToolSyncSchedulerForTests
} from '../../src/agent/ws-server.js';
import { config } from '../../src/config.js';
import { redis } from '../../src/infra/redis.js';
import { AgentOwnerRecord } from '../../src/services/control-plane-coordination.js';
import { webhooks } from '../../src/services/webhooks.js';
import { repo } from '../../src/store/repository.js';
import { runtime } from '../../src/store/runtime.js';
import { TargetAgentRegistration, Cluster, RunEvent } from '../../src/types/domain.js';
import { hashSecret } from '../../src/utils/crypto.js';

export const mutableConfig = config as typeof config & {
  CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED: boolean;
  CONTROL_PLANE_INSTANCE_ID: string;
  CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS: number;
  AGENT_WS_REQUIRE_SECURE_TRANSPORT: boolean;
};

const originalDistributedRouting = config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED;
const originalInstanceId = config.CONTROL_PLANE_INSTANCE_ID;
const originalOwnerTtl = config.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS;
const originalRequireSecureAgentTransport = config.AGENT_WS_REQUIRE_SECURE_TRANSPORT;

export interface PublishedMessage {
  channel: string;
  message: string;
}

export interface EvalCall {
  kind: 'delete' | 'owner-delete' | 'owner-renew' | 'renew';
  key: string;
  firstArg: string;
  secondArg?: string;
}

export interface AgentFixture {
  clusterId: string;
  workspaceId: string;
  agentKey: string;
  status?: Cluster['status'];
}

export class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;

  sent: string[] = [];

  closeCode?: number;

  closeReason?: string;

  send(data: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(String(data));
    cb?.();
  }

  close(code?: number, reason?: string | Buffer): void {
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason ? reason.toString() : undefined;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function agentOwnerKey(clusterId: string): string {
  return `cp:agent:owner:${clusterId}`;
}

export function installRedisStore(
  store: Map<string, string>,
  published: PublishedMessage[] = [],
  publishReceivers = 1
): { evalCalls: EvalCall[] } {
  const evalCalls: EvalCall[] = [];
  mock.method(redis, 'get', async (key: string) => store.get(key) || null);
  mock.method(redis, 'set', async (...args: unknown[]) => {
    const key = String(args[0]);
    const value = String(args[1]);
    const nx = args.some((arg) => String(arg).toUpperCase() === 'NX');
    if (nx && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  });
  mock.method(redis, 'del', async (key: string) => store.delete(key) ? 1 : 0);
  mock.method(redis, 'eval', async (
    script: string,
    _keyCount: number,
    key: string,
    firstArg: string,
    secondArg?: string,
    _thirdArg?: string,
    fourthArg?: string
  ) => {
    const current = store.get(key);
    if (String(script).includes('cjson.encode') && String(script).includes('updatedAt')) {
      evalCalls.push({ kind: 'owner-renew', key, firstArg, secondArg });
      if (!current) return 0;
      const decoded = JSON.parse(current) as Record<string, unknown>;
      if (decoded.instanceId === firstArg && decoded.connectionId === secondArg) {
        store.set(key, JSON.stringify({ ...decoded, updatedAt: fourthArg }));
        return 1;
      }
      return 0;
    }
    if (String(script).includes('EXPIRE')) {
      evalCalls.push({ kind: 'renew', key, firstArg, secondArg });
      return current === firstArg ? 1 : 0;
    }
    if (!current) return 0;
    if (secondArg === undefined) {
      evalCalls.push({ kind: 'delete', key, firstArg });
      if (current === firstArg) {
        store.delete(key);
        return 1;
      }
      return 0;
    }
    evalCalls.push({ kind: 'owner-delete', key, firstArg, secondArg });
    const decoded = JSON.parse(current) as { instanceId?: string; connectionId?: string };
    if (decoded.instanceId === firstArg && decoded.connectionId === secondArg) {
      store.delete(key);
      return 1;
    }
    return 0;
  });
  mock.method(redis, 'publish', async (channel: string, message: string) => {
    published.push({ channel, message });
    return publishReceivers;
  });
  return { evalCalls };
}

function createCluster(input: AgentFixture): Cluster {
  return {
    id: input.clusterId,
    workspaceId: input.workspaceId,
    name: input.clusterId,
    status: input.status || 'offline',
    namespaceInclude: [],
    namespaceExclude: [],
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: '2026-05-19T00:00:00.000Z'
  };
}

export function installAgentRepoMocks(agents: AgentFixture[]): {
  clusterUpdates: Array<{ clusterId: string; patch: Partial<Cluster> }>;
  agentSeenUpdates: Array<{ clusterId: string; patch: Record<string, unknown> }>;
  snapshots: Array<{ clusterId: string; workspaceId: string; timestamp: string; data: Record<string, unknown> }>;
} {
  const clusters = new Map(agents.map((agent) => [agent.clusterId, createCluster(agent)]));
  const registrations: TargetAgentRegistration[] = agents.map((agent) => ({
    targetId: agent.clusterId,
    targetType: 'kubernetes',
    workspaceId: agent.workspaceId,
    agentKeyHash: hashSecret(agent.agentKey),
    keyVersion: 1,
    capabilities: []
  }));
  const clusterUpdates: Array<{ clusterId: string; patch: Partial<Cluster> }> = [];
  const agentSeenUpdates: Array<{ clusterId: string; patch: Record<string, unknown> }> = [];
  const snapshots: Array<{ clusterId: string; workspaceId: string; timestamp: string; data: Record<string, unknown> }> = [];

  mock.method(repo, 'listTargetAgentRegistrations', async () => registrations);
  mock.method(repo, 'getTargetAgentRegistration', async (clusterId: string) => {
    return registrations.find((entry) => entry.targetId === clusterId) || null;
  });
  mock.method(repo, 'upsertTargetAgentRegistration', async (registration: TargetAgentRegistration) => {
    const index = registrations.findIndex((entry) => entry.targetId === registration.targetId);
    if (index >= 0) registrations[index] = registration;
  });
  mock.method(repo, 'getCluster', async (clusterId: string) => clusters.get(clusterId) || null);
  mock.method(repo, 'updateCluster', async (clusterId: string, patch: Partial<Cluster>) => {
    const existing = clusters.get(clusterId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: '2026-05-19T00:01:00.000Z' };
    clusters.set(clusterId, updated);
    clusterUpdates.push({ clusterId, patch });
    return updated;
  });
  mock.method(repo, 'updateTargetAgentSeen', async (clusterId: string, patch: Record<string, unknown>) => {
    agentSeenUpdates.push({ clusterId, patch });
  });
  mock.method(repo, 'upsertClusterSnapshot', async (snapshot: {
    clusterId: string;
    workspaceId: string;
    timestamp: string;
    data: Record<string, unknown>;
  }) => {
    snapshots.push(snapshot);
  });
  mock.method(webhooks, 'emit', () => undefined);

  return { clusterUpdates, agentSeenUpdates, snapshots };
}

export async function connectAgent(gateway: AgentGateway, input: AgentFixture): Promise<FakeWebSocket> {
  const internal = gateway as unknown as {
    handleConnection(ws: WebSocket, request: IncomingMessage): void;
    handleMessage(ws: WebSocket, raw: WebSocket.RawData, agentKeyHeader: string, agentVersion: string): Promise<void>;
  };
  const ws = new FakeWebSocket();
  internal.handleConnection(ws as unknown as WebSocket, {
    headers: {
      'x-agent-key': input.agentKey,
      'x-agent-version': 'agent-test'
    }
  } as IncomingMessage);
  await internal.handleMessage(
    ws as unknown as WebSocket,
    Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: `handshake-${input.clusterId}`,
      method: 'lifecycle/handshake',
      params: {
        targetId: input.clusterId,
        targetType: 'kubernetes',
        agentType: 'k8s_agent',
        agentKey: input.agentKey,
        supportedCapabilities: ['read']
      }
    })),
    input.agentKey,
    'agent-test'
  );
  const response = JSON.parse(ws.sent.at(-1) || '{}') as { result?: { targetId?: string; targetType?: string } };
  assert.equal(response.result?.targetId, input.clusterId);
  assert.equal(response.result?.targetType, 'kubernetes');
  await sleep(0);
  const maybeToolSyncCommand = parseLastSent(ws);
  if (maybeToolSyncCommand.method === 'tools/list' && typeof maybeToolSyncCommand.id === 'string') {
    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      id: maybeToolSyncCommand.id,
      result: { tools: [] }
    });
    await sleep(0);
  }
  return ws;
}

export async function sendAgentMessage(gateway: AgentGateway, ws: FakeWebSocket, payload: unknown): Promise<void> {
  const internal = gateway as unknown as {
    handleMessage(ws: WebSocket, raw: WebSocket.RawData, agentKeyHeader: string, agentVersion: string): Promise<void>;
  };
  await internal.handleMessage(
    ws as unknown as WebSocket,
    Buffer.from(JSON.stringify(payload)),
    '',
    'agent-test'
  );
}

export function parseLastSent(ws: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent.at(-1) || '{}') as Record<string, unknown>;
}

export async function waitForSentMessage(
  ws: FakeWebSocket,
  startIndex: number,
  predicate: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    for (const raw of ws.sent.slice(startIndex)) {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (predicate(message)) return message;
    }
    await sleep(10);
  }
  throw new Error('Timed out waiting for expected websocket message');
}

export function setOwner(store: Map<string, string>, clusterId: string, owner: AgentOwnerRecord): void {
  store.set(agentOwnerKey(clusterId), JSON.stringify(owner));
}

export function testRunEvent(seq = 1): RunEvent {
  return {
    schema_version: 1,
    run_id: 'run-1',
    seq,
    ts: '2026-05-19T00:00:00.000Z',
    type: 'run_started',
    payload: {}
  };
}

export function setupControlPlaneCoordinationTest(): void {
  mutableConfig.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = true;
  mutableConfig.CONTROL_PLANE_INSTANCE_ID = 'cp-test-a';
  mutableConfig.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS = 90;
  mutableConfig.AGENT_WS_REQUIRE_SECURE_TRANSPORT = false;
  setBuiltInToolSyncSchedulerForTests(() => undefined);
}

export function teardownControlPlaneCoordinationTest(): void {
  resetAgentGatewayStateForTests();
  setBuiltInToolSyncSchedulerForTests();
  runtime.agentCommands.clear();
  mock.restoreAll();
  mutableConfig.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = originalDistributedRouting;
  mutableConfig.CONTROL_PLANE_INSTANCE_ID = originalInstanceId;
  mutableConfig.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS = originalOwnerTtl;
  mutableConfig.AGENT_WS_REQUIRE_SECURE_TRANSPORT = originalRequireSecureAgentTransport;
}
