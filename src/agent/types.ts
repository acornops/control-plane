import WebSocket from 'ws';
import type { TargetType } from '../types/domain.js';
import type { BuiltInToolSyncResult } from '../services/target-built-in-tool-sync.js';

export interface AgentConnection {
  connectionId: string;
  ws: WebSocket;
  clusterId: string;
  targetType: TargetType;
  workspaceId: string;
  keyVersion: number;
  agentVersion?: string;
  ownerRefreshInterval?: NodeJS.Timeout;
}

export type BuiltInToolSyncScheduler = (workspaceId: string, targetId: string, targetType: TargetType) => void;
export type BuiltInToolSyncRunner = (
  workspaceId: string,
  targetId: string,
  targetType: TargetType
) => Promise<BuiltInToolSyncResult>;

export interface AgentToolDefinition {
  name: string;
  description: string;
  capability?: 'read' | 'write';
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  artifactPolicy?: 'never' | 'if_detailed' | 'always';
  timeout_ms?: number;
  version?: string;
  deprecated?: boolean;
}

/** A sanitized JSON-RPC tool failure returned by a connected target agent. */
export class AgentToolCallError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number,
    readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentToolCallError';
  }
}

/** The target agent was unavailable before the command could be dispatched. */
export class AgentUnavailableError extends Error {
  constructor() {
    super('Target agent is temporarily unavailable');
    this.name = 'AgentUnavailableError';
  }
}
