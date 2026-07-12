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
  input_schema?: Record<string, unknown>;
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
