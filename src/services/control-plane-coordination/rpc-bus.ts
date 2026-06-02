import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import { logger } from '../../logger.js';
import { AgentOwnerRecord } from './agent-owner.js';
import { distributedRoutingEnabled, parseJsonObject } from './common.js';

export interface AgentRpcRequest {
  requestId: string;
  clusterId: string;
  method: string;
  params: Record<string, unknown>;
  replyChannel: string;
  originInstanceId: string;
  expectedConnectionId: string;
}

export interface AgentRpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: 'OWNER_MISMATCH' | 'AGENT_UNAVAILABLE' | 'COMMAND_TIMEOUT' | 'COMMAND_FAILED';
}

type AgentRpcHandler = (request: AgentRpcRequest) => Promise<AgentRpcResponse>;

let agentRpcHandler: AgentRpcHandler | undefined;
let rpcSubscriber: Redis | undefined;
let responseSubscriber: Redis | undefined;

const pendingRemoteCommands = new Map<string, {
  resolve: (value: AgentRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

function agentRpcChannel(instanceId: string): string {
  return `cp:agent:rpc:${instanceId}`;
}

function agentRpcResponsePattern(): string {
  return `cp:agent:rpc:response:${config.CONTROL_PLANE_INSTANCE_ID}:*`;
}

function parseAgentRpcRequest(value: string): AgentRpcRequest | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed) return undefined;
  if (
    typeof parsed.requestId !== 'string' ||
    typeof parsed.clusterId !== 'string' ||
    typeof parsed.method !== 'string' ||
    typeof parsed.replyChannel !== 'string' ||
    typeof parsed.originInstanceId !== 'string' ||
    typeof parsed.expectedConnectionId !== 'string'
  ) {
    return undefined;
  }
  const params = parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
    ? parsed.params as Record<string, unknown>
    : {};
  return {
    requestId: parsed.requestId,
    clusterId: parsed.clusterId,
    method: parsed.method,
    params,
    replyChannel: parsed.replyChannel,
    originInstanceId: parsed.originInstanceId,
    expectedConnectionId: parsed.expectedConnectionId
  };
}

function parseAgentRpcResponse(value: string): AgentRpcResponse | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.ok !== 'boolean') {
    return undefined;
  }
  return {
    requestId: parsed.requestId,
    ok: parsed.ok,
    result: parsed.result,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
    code: typeof parsed.code === 'string' ? parsed.code as AgentRpcResponse['code'] : undefined
  };
}

export function registerAgentRpcHandler(handler: AgentRpcHandler): void {
  agentRpcHandler = handler;
}

export async function startAgentRpcBus(): Promise<void> {
  rpcSubscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
  responseSubscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });

  rpcSubscriber.on('message', (channel, message) => {
    void handleAgentRpcMessage(channel, message);
  });
  responseSubscriber.on('pmessage', (_pattern, _channel, message) => {
    handleAgentRpcResponse(message);
  });

  await Promise.all([rpcSubscriber.connect(), responseSubscriber.connect()]);
  await Promise.all([
    rpcSubscriber.subscribe(agentRpcChannel(config.CONTROL_PLANE_INSTANCE_ID)),
    responseSubscriber.psubscribe(agentRpcResponsePattern())
  ]);
}

export async function stopAgentRpcBus(): Promise<void> {
  for (const pending of pendingRemoteCommands.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Control plane is shutting down'));
  }
  pendingRemoteCommands.clear();

  await Promise.all([
    rpcSubscriber?.quit().catch(() => undefined),
    responseSubscriber?.quit().catch(() => undefined)
  ]);
  rpcSubscriber = undefined;
  responseSubscriber = undefined;
}

async function handleAgentRpcMessage(_channel: string, message: string): Promise<void> {
  const request = parseAgentRpcRequest(message);
  if (!request || !agentRpcHandler) return;

  let response: AgentRpcResponse;
  try {
    response = await agentRpcHandler(request);
  } catch (err) {
    response = {
      requestId: request.requestId,
      ok: false,
      code: 'COMMAND_FAILED',
      error: err instanceof Error ? err.message : 'Agent command failed'
    };
  }

  await redis.publish(request.replyChannel, JSON.stringify(response)).catch((err) => {
    logger.warn({ err, requestId: request.requestId }, 'Failed publishing agent RPC response');
  });
}

export async function handleAgentRpcMessageForTests(message: string): Promise<void> {
  await handleAgentRpcMessage(agentRpcChannel(config.CONTROL_PLANE_INSTANCE_ID), message);
}

function handleAgentRpcResponse(message: string): void {
  const response = parseAgentRpcResponse(message);
  if (!response) return;
  const pending = pendingRemoteCommands.get(response.requestId);
  if (!pending) return;
  pendingRemoteCommands.delete(response.requestId);
  clearTimeout(pending.timeout);
  pending.resolve(response);
}

export async function requestRemoteAgentRpc(owner: AgentOwnerRecord, input: {
  clusterId: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}): Promise<AgentRpcResponse> {
  if (!distributedRoutingEnabled()) {
    return {
      requestId: '',
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      error: 'Agent is not connected'
    };
  }

  const requestId = `rpc_${randomUUID()}`;
  const replyChannel = `cp:agent:rpc:response:${config.CONTROL_PLANE_INSTANCE_ID}:${requestId}`;
  const payload: AgentRpcRequest = {
    requestId,
    clusterId: input.clusterId,
    method: input.method,
    params: input.params,
    replyChannel,
    originInstanceId: config.CONTROL_PLANE_INSTANCE_ID,
    expectedConnectionId: owner.connectionId
  };

  const promise = new Promise<AgentRpcResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRemoteCommands.delete(requestId);
      reject(new Error('Agent command timed out'));
    }, input.timeoutMs);
    pendingRemoteCommands.set(requestId, { resolve, reject, timeout });
  });

  let receivers: number;
  try {
    receivers = await redis.publish(agentRpcChannel(owner.instanceId), JSON.stringify(payload));
  } catch (err) {
    const pending = pendingRemoteCommands.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRemoteCommands.delete(requestId);
    }
    throw err;
  }
  if (receivers < 1) {
    const pending = pendingRemoteCommands.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRemoteCommands.delete(requestId);
    }
    return {
      requestId,
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      error: 'Agent is not connected'
    };
  }

  return promise;
}
