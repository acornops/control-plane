import WebSocket from 'ws';
import type { TargetType } from '../types/domain.js';

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

export interface AgentToolDefinition {
  name: string;
  description: string;
  capability?: 'read' | 'write';
  input_schema?: Record<string, unknown>;
  timeout_ms?: number;
  version?: string;
  deprecated?: boolean;
}
