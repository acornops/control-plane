import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { isJsonRpcResponse } from '../types/jsonrpc.js';
import { repo } from '../store/repository.js';
import {
  closeStaleAgentConnection,
  detachAgentConnection,
  getAgentConnection,
  getAgentConnectionForWebSocket,
  listAgentConnections,
  resetAgentConnectionsForTests,
  resolvePendingAgentResponse
} from './connections.js';
import { handleAgentHandshake } from './handshake.js';
import { AGENT_COMMAND_TIMEOUT_MS, sendLocalJsonRpc } from './local-jsonrpc.js';
import { decodeAgentMessage } from './message-utils.js';
import { markConnectionOfflineIfUnowned } from './offline-reconciliation.js';
import { setBuiltInToolSyncSchedulerForTests as setBuiltInToolSyncSchedulerForTestsInternal } from './tool-sync-scheduler.js';
import { AgentConnection, AgentToolCallError, AgentToolDefinition, AgentUnavailableError, BuiltInToolSyncScheduler } from './types.js';
import {
  AgentRpcRequest,
  AgentRpcResponse,
  clearAgentOwnerIfCurrent,
  controlPlaneInstanceId,
  distributedRoutingEnabled,
  getAgentOwner,
  isCurrentAgentOwner,
  refreshAgentOwner,
  registerAgentRpcHandler,
  requestRemoteAgentRpc
} from '../services/control-plane-coordination.js';

export type { AgentToolDefinition } from './types.js';

/** Distinguish an MCP CallToolResult from a domain object that happens to contain `content`. */
export function isMcpToolResultEnvelope(result: unknown): result is Record<string, unknown> {
  if (!result || typeof result !== 'object') return false;
  const value = result as Record<string, unknown>;
  if (!Array.isArray(value.content)) return false;
  const hasEnvelopeMarker = Object.prototype.hasOwnProperty.call(value, 'isError')
    || (value.structuredContent !== null && typeof value.structuredContent === 'object')
    || (value._meta !== null && typeof value._meta === 'object');
  return hasEnvelopeMarker && value.content.every((block) => (
    Boolean(block) && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string'
  ));
}

function forwardedProto(request: IncomingMessage): string {
  const raw = request.headers['x-forwarded-proto'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').split(',')[0]?.trim().toLowerCase() || '';
}

function isSecureAgentUpgrade(request: IncomingMessage): boolean {
  const encrypted = Boolean((request.socket as Duplex & { encrypted?: boolean }).encrypted);
  if (encrypted) return true;
  const proto = forwardedProto(request);
  return proto === 'https' || proto === 'wss';
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export class AgentGateway {
  private readonly wss: WebSocketServer;
  private readonly handshakeTimers = new WeakMap<WebSocket, NodeJS.Timeout>();
  private readonly preAuthHandshakeAttempts = new Map<string, { count: number; resetAt: number }>();
  private shuttingDown = false;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.AGENT_WS_MAX_PAYLOAD_BYTES });
    this.wss.on('connection', (ws, request) => this.handleConnection(ws, request));
    registerAgentRpcHandler((request) => this.handleRemoteAgentRpc(request));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (this.shuttingDown) {
      socket.destroy();
      return true;
    }
    const url = new URL(request.url || '', 'http://localhost');
    if (url.pathname !== '/agent/v1/connect' && url.pathname !== '/api/v1/agent/connect') {
      return false;
    }
    if (config.AGENT_WS_REQUIRE_SECURE_TRANSPORT && !isSecureAgentUpgrade(request)) {
      logger.warn({ forwardedProto: forwardedProto(request) || 'missing' }, 'Rejected insecure agent websocket upgrade');
      rejectUpgrade(socket, 400, 'Secure WebSocket required');
      return true;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
    return true;
  }

  async shutdown(graceMs = 5000): Promise<void> {
    this.shuttingDown = true;
    const activeConnections = listAgentConnections();

    await Promise.all(activeConnections.map(async ([clusterId, conn]) => {
      detachAgentConnection(clusterId, conn, 'Agent connection closed');
      await new Promise<void>((resolve) => {
        if (conn.ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          if (conn.ws.readyState !== WebSocket.CLOSED) {
            conn.ws.terminate();
          }
          resolve();
        }, graceMs);
        timeout.unref();
        conn.ws.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
          conn.ws.close(1001, 'Control plane shutting down');
        } else {
          resolve();
        }
      });
      await markConnectionOfflineIfUnowned(clusterId, conn).catch((err) => {
        logger.warn({ err, clusterId }, 'Failed updating cluster offline status during shutdown');
      });
    }));

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  async callAgentMcpTool(clusterId: string, toolName: string, args: Record<string, unknown>, requestId?: string): Promise<unknown> {
    return this.sendJsonRpc(clusterId, 'tools/call', {
      name: toolName,
      arguments: args
    }, requestId);
  }

  /** Call an Agent tool for a direct API consumer and unwrap its complete structured result. */
  async callAgentTool(clusterId: string, toolName: string, args: Record<string, unknown>, requestId?: string): Promise<unknown> {
    const result = await this.callAgentMcpTool(clusterId, toolName, args, requestId);
    if (isMcpToolResultEnvelope(result)) {
      if ((result as { isError?: unknown }).isError === true) {
        const structured = (result as { structuredContent?: { data?: unknown } }).structuredContent;
        const data = structured?.data && typeof structured.data === 'object'
          ? structured.data as Record<string, unknown>
          : undefined;
        throw new AgentToolCallError(
          typeof data?.message === 'string' ? data.message : 'Agent tool call failed',
          -32000,
          data
        );
      }
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      if (structured && typeof structured === 'object' &&
          (structured as { schemaVersion?: unknown }).schemaVersion === 'acornops.full-tool-result.v1' &&
          Object.prototype.hasOwnProperty.call(structured, 'data')) {
        return (structured as { data: unknown }).data;
      }
    }
    throw new AgentToolCallError('Target agent returned an invalid MCP tool result', -32603, {
      code: 'INTERNAL_ERROR',
      outcome: 'not_started'
    });
  }

  async listAgentTools(clusterId: string): Promise<AgentToolDefinition[]> {
    const result = (await this.sendJsonRpc(clusterId, 'tools/list', {})) as {
      tools?: AgentToolDefinition[];
    };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.filter((tool) => typeof tool?.name === 'string' && typeof tool?.description === 'string');
  }

  async disconnectCluster(clusterId: string, reason = 'Agent connection closed'): Promise<boolean> {
    const conn = getAgentConnection(clusterId);
    if (!conn) {
      return false;
    }
    await this.closeLocalConnection(clusterId, conn, 1008, reason, reason);
    return true;
  }

  async updateNamespaceScope(clusterId: string, scope: { include: string[]; exclude: string[] }): Promise<unknown> {
    return this.sendJsonRpc(clusterId, 'config/update_namespace_scope', {
      namespaceScope: scope
    });
  }

  async sendJsonRpc(clusterId: string, method: string, params: Record<string, unknown>, requestId?: string): Promise<unknown> {
    return this.sendJsonRpcWithRetry(clusterId, method, params, true, requestId);
  }
  async isAgentConnected(clusterId: string): Promise<boolean> {
    const conn = getAgentConnection(clusterId);
    if (conn?.ws.readyState === WebSocket.OPEN) return !distributedRoutingEnabled()
      || await isCurrentAgentOwner(clusterId, conn.connectionId);
    if (!distributedRoutingEnabled()) return false;
    return Boolean(await getAgentOwner(clusterId));
  }
  private async sendJsonRpcWithRetry(
    clusterId: string,
    method: string,
    params: Record<string, unknown>,
    retryOnOwnerMismatch: boolean,
    requestId?: string
  ): Promise<unknown> {
    const conn = getAgentConnection(clusterId);
    if (conn?.ws.readyState === WebSocket.OPEN) {
      if (!distributedRoutingEnabled() || await isCurrentAgentOwner(clusterId, conn.connectionId)) {
        return sendLocalJsonRpc(conn, method, params, requestId);
      }
      this.closeStaleLocalConnection(clusterId, conn);
    }

    if (!distributedRoutingEnabled()) {
      throw new AgentUnavailableError();
    }

    const owner = await getAgentOwner(clusterId);
    if (!owner) {
      throw new AgentUnavailableError();
    }
    if (owner.instanceId === controlPlaneInstanceId()) {
      if (retryOnOwnerMismatch) {
        await clearAgentOwnerIfCurrent(clusterId, owner.connectionId);
        return this.sendJsonRpcWithRetry(clusterId, method, params, false, requestId);
      }
      throw new AgentUnavailableError();
    }

    const response = await requestRemoteAgentRpc(owner, {
      clusterId,
      method,
      params,
      timeoutMs: AGENT_COMMAND_TIMEOUT_MS + 5_000,
      agentRequestId: requestId
    });
    if (!response.ok) {
      if (response.code === 'OWNER_MISMATCH' && retryOnOwnerMismatch) {
        return this.sendJsonRpcWithRetry(clusterId, method, params, false, requestId);
      }
      if (response.agentError) {
        throw new AgentToolCallError(response.agentError.message, response.agentError.rpcCode, response.agentError.data);
      }
      if (response.code === 'AGENT_UNAVAILABLE') throw new AgentUnavailableError();
      throw new Error(response.error || 'Agent command failed');
    }
    return response.result;
  }

  private async handleRemoteAgentRpc(request: AgentRpcRequest): Promise<AgentRpcResponse> {
    const conn = getAgentConnection(request.clusterId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      await clearAgentOwnerIfCurrent(request.clusterId, request.expectedConnectionId);
      return {
        requestId: request.requestId,
        ok: false,
        code: 'OWNER_MISMATCH',
        error: 'Agent ownership changed'
      };
    }
    if (conn.connectionId !== request.expectedConnectionId || !(await isCurrentAgentOwner(request.clusterId, conn.connectionId))) {
      return {
        requestId: request.requestId,
        ok: false,
        code: 'OWNER_MISMATCH',
        error: 'Agent ownership changed'
      };
    }
    try {
      const result = await sendLocalJsonRpc(conn, request.method, request.params, request.agentRequestId);
      return {
        requestId: request.requestId,
        ok: true,
        result
      };
    } catch (err) {
      return {
        requestId: request.requestId,
        ok: false,
        code: err instanceof Error && /timed out/i.test(err.message) ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED',
        error: err instanceof Error ? err.message : 'Agent command failed',
        ...(err instanceof AgentToolCallError ? {
          agentError: { rpcCode: err.rpcCode, message: err.message, data: err.data }
        } : {})
      };
    }
  }

  private closeStaleLocalConnection(clusterId: string, conn: AgentConnection): void {
    closeStaleAgentConnection(clusterId, conn);
  }

  private async closeLocalConnection(
    clusterId: string,
    conn: AgentConnection,
    closeCode: number,
    closeReason: string,
    pendingReason: string
  ): Promise<void> {
    detachAgentConnection(clusterId, conn, pendingReason);
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(closeCode, closeReason);
    }
    await markConnectionOfflineIfUnowned(clusterId, conn).catch((err) => {
      logger.warn({ err, clusterId }, 'Failed updating cluster offline status after closing agent connection');
    });
  }

  private async ensureAgentConnectionCurrent(conn: AgentConnection): Promise<boolean> {
    const registration = await repo.getTargetAgentRegistration(conn.clusterId);
    if (registration?.keyVersion === conn.keyVersion) {
      return true;
    }
    await this.closeLocalConnection(
      conn.clusterId,
      conn,
      1008,
      'Agent key rotated',
      'Agent key rotated'
    );
    return false;
  }

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const agentKeyHeader = String(request.headers['x-agent-key'] || '');
    const agentVersion = String(request.headers['x-agent-version'] || 'unknown');
    const remoteAddress = request.socket?.remoteAddress || 'unknown';

    logger.info({ agentVersion }, 'Agent websocket connected');

    const handshakeTimer = setTimeout(() => {
      if (!getAgentConnectionForWebSocket(ws) && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'Agent handshake timeout');
      }
    }, config.AGENT_WS_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();
    this.handshakeTimers.set(ws, handshakeTimer);

    ws.on('message', (raw) => {
      this.handleMessage(ws, raw, agentKeyHeader, agentVersion, remoteAddress).catch((err) => {
        logger.error({ err }, 'Failed to handle agent message');
      });
    });

    ws.on('close', () => {
      this.clearHandshakeTimer(ws);
      const conn = getAgentConnectionForWebSocket(ws);
      if (conn) {
        detachAgentConnection(conn.clusterId, conn, 'Agent connection closed');
        void markConnectionOfflineIfUnowned(conn.clusterId, conn).catch((err) => {
          logger.warn({ err, clusterId: conn.clusterId }, 'Failed updating cluster offline status after agent disconnect');
        });
      }
      logger.info('Agent websocket closed');
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'Agent websocket error');
    });
  }

  private clearHandshakeTimer(ws: WebSocket): void {
    const timer = this.handshakeTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimers.delete(ws);
    }
  }

  private isPreAuthHandshakeRateLimited(remoteAddress: string): boolean {
    const now = Date.now();
    const current = this.preAuthHandshakeAttempts.get(remoteAddress);
    if (!current || current.resetAt <= now) {
      this.preAuthHandshakeAttempts.set(remoteAddress, {
        count: 1,
        resetAt: now + config.AGENT_WS_PREAUTH_RATE_LIMIT_WINDOW_MS
      });
      return false;
    }
    current.count += 1;
    return current.count > config.AGENT_WS_PREAUTH_MAX_HANDSHAKES_PER_WINDOW;
  }

  private closeUnauthenticated(ws: WebSocket, reason: string): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1008, reason);
    }
  }

  private async handleMessage(
    ws: WebSocket,
    raw: WebSocket.RawData,
    agentKeyHeader: string,
    agentVersion: string,
    remoteAddress = 'unknown'
  ): Promise<void> {
    const authenticated = Boolean(getAgentConnectionForWebSocket(ws));
    let decoded: string;
    try {
      decoded = await decodeAgentMessage(raw, {
        allowCompression: authenticated,
        maxRawBytes: authenticated ? config.AGENT_WS_MAX_PAYLOAD_BYTES : config.AGENT_WS_PREAUTH_MAX_BYTES,
        maxDecodedBytes: authenticated ? config.AGENT_WS_MAX_DECODED_BYTES : config.AGENT_WS_PREAUTH_MAX_BYTES
      });
    } catch (err) {
      logger.warn({ err, authenticated }, 'Dropping oversized or disallowed agent message');
      this.closeUnauthenticated(ws, 'Invalid agent message');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(decoded);
    } catch {
      logger.warn({ preview: decoded.slice(0, 256) }, 'Dropping non-JSON agent message');
      if (!authenticated) {
        this.closeUnauthenticated(ws, 'Handshake must be valid JSON');
      }
      return;
    }

    if (isJsonRpcResponse(payload)) {
      if (!authenticated) {
        this.closeUnauthenticated(ws, 'Handshake required');
        return;
      }
      resolvePendingAgentResponse(ws, payload);
      return;
    }

    if (!payload || typeof payload !== 'object') {
      if (!authenticated) {
        this.closeUnauthenticated(ws, 'Handshake required');
      }
      return;
    }

    const message = payload as { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: Record<string, unknown> };
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (!authenticated) {
        this.closeUnauthenticated(ws, 'Handshake required');
      }
      return;
    }
    const requestId = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;

    if (message.method === 'lifecycle/handshake') {
      if (requestId === undefined) {
        this.closeUnauthenticated(ws, 'Handshake request id required');
        return;
      }
      if (!authenticated && this.isPreAuthHandshakeRateLimited(remoteAddress)) {
        this.closeUnauthenticated(ws, 'Agent handshake rate limit exceeded');
        return;
      }
      await handleAgentHandshake({
        ws,
        requestId,
        params: message.params || {},
        agentKeyHeader,
        agentVersion
      });
      if (getAgentConnectionForWebSocket(ws)) {
        this.clearHandshakeTimer(ws);
      }
      return;
    }

    if (!authenticated) {
      this.closeUnauthenticated(ws, 'Handshake required');
      return;
    }

    if (message.method === 'lifecycle/heartbeat') {
      const conn = getAgentConnectionForWebSocket(ws);
      if (conn) {
        if (!(await this.ensureAgentConnectionCurrent(conn))) {
          return;
        }
        if (!(await refreshAgentOwner(conn.clusterId, conn.connectionId))) {
          this.closeStaleLocalConnection(conn.clusterId, conn);
          return;
        }
        const now = new Date().toISOString();
        await repo.updateTargetAgentSeen(conn.clusterId, {
          lastSeenAt: now,
          lastHeartbeatAt: now
        });
      }
      return;
    }

    if (message.method === 'notify/snapshot') {
      const conn = getAgentConnectionForWebSocket(ws);
      if (!conn) return;
      if (!(await this.ensureAgentConnectionCurrent(conn))) {
        return;
      }
      if (!(await refreshAgentOwner(conn.clusterId, conn.connectionId))) {
        this.closeStaleLocalConnection(conn.clusterId, conn);
        return;
      }

      const timestamp = String((message.params?.timestamp as string | undefined) || new Date().toISOString());
      const data = (message.params?.data as Record<string, unknown> | undefined) || {};
      if (conn.targetType === 'virtual_machine') {
        await repo.upsertVirtualMachineSnapshot({
          targetId: conn.clusterId,
          workspaceId: conn.workspaceId,
          timestamp,
          data
        });
      } else {
        await repo.upsertClusterSnapshot({
          clusterId: conn.clusterId,
          workspaceId: conn.workspaceId,
          timestamp,
          data
        });
      }
      return;
    }
  }
}

export const agentGateway = new AgentGateway();

export function resetAgentGatewayStateForTests(): void {
  resetAgentConnectionsForTests();
}

export function setBuiltInToolSyncSchedulerForTests(scheduler?: BuiltInToolSyncScheduler): void {
  setBuiltInToolSyncSchedulerForTestsInternal(scheduler);
}
