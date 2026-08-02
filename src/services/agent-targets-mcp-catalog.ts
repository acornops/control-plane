import type { AgentMcpInstallationSnapshot } from '../types/agents.js';

export const AGENT_TARGETS_MCP_SERVER_NAME = 'AcornOps Targets';

export const AGENT_TARGETS_MCP_TOOL_NAMES = [
  'list_targets',
  'get_target',
  'list_target_issues'
] as const;

export type AgentTargetsMcpToolName = typeof AGENT_TARGETS_MCP_TOOL_NAMES[number];

export interface AgentTargetsMcpToolDefinition {
  name: AgentTargetsMcpToolName;
  timeoutMs: number;
  description: string;
  capability: 'read';
  version: 'v1';
  source: 'builtin';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  artifactPolicy: 'never';
  enabled: boolean;
  reviewState: 'approved';
  riskLevel: 'read_only';
  autoAllowed: false;
}

const targetSummarySchema = {
  type: 'object',
  required: ['id', 'name', 'target_type', 'connection_status', 'created_at', 'updated_at'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    target_type: { enum: ['kubernetes', 'virtual_machine'] },
    connection_status: { enum: ['online', 'offline', 'degraded', 'unknown'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' }
  }
} as const;

const issueSchema = {
  type: 'object',
  required: [
    'id', 'target_id', 'target_type', 'issue_type', 'status', 'severity',
    'title', 'summary', 'first_seen_at', 'last_seen_at', 'last_observed_snapshot_at'
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    target_id: { type: 'string' },
    target_type: { enum: ['kubernetes', 'virtual_machine'] },
    issue_type: { type: 'string', maxLength: 200 },
    status: { enum: ['active', 'recovering', 'resolved'] },
    severity: { enum: ['critical', 'warning', 'info'] },
    title: { type: 'string', maxLength: 500 },
    summary: { type: 'string', maxLength: 2000 },
    scope_kind: { type: 'string', maxLength: 200 },
    scope_name: { type: 'string', maxLength: 500 },
    namespace: { type: 'string', maxLength: 500 },
    object_kind: { type: 'string', maxLength: 200 },
    object_name: { type: 'string', maxLength: 500 },
    reason: { type: 'string', maxLength: 1000 },
    first_seen_at: { type: 'string' },
    last_seen_at: { type: 'string' },
    last_observed_snapshot_at: { type: 'string' },
    occurrence_count: { type: 'integer' },
    reopened_count: { type: 'integer' }
  }
} as const;

function readTool(
  definition: Pick<AgentTargetsMcpToolDefinition, 'name' | 'description' | 'inputSchema' | 'outputSchema'>,
  timeoutMs: number
): AgentTargetsMcpToolDefinition {
  return {
    ...definition,
    timeoutMs,
    capability: 'read',
    version: 'v1',
    source: 'builtin',
    artifactPolicy: 'never',
    enabled: true,
    reviewState: 'approved',
    riskLevel: 'read_only',
    autoAllowed: false
  };
}

export function agentTargetsMcpTools(timeoutMs: number): AgentTargetsMcpToolDefinition[] {
  return [
    readTool({
      name: 'list_targets',
      description: 'List targets available to this Agent. Use the returned target ID with get_target or list_target_issues.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 200 },
          target_type: { enum: ['kubernetes', 'virtual_machine'] },
          limit: { type: 'integer', minimum: 1, maximum: 25 },
          cursor: { type: 'string', maxLength: 4096 }
        }
      },
      outputSchema: {
        type: 'object',
        required: ['items'],
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: targetSummarySchema },
          next_cursor: { type: 'string' }
        }
      }
    }, timeoutMs),
    readTool({
      name: 'get_target',
      description: 'Get normalized details, connection freshness, and active issue counts for one target available to this Agent.',
      inputSchema: {
        type: 'object',
        required: ['target_id'],
        additionalProperties: false,
        properties: {
          target_id: { type: 'string', minLength: 1, maxLength: 256 }
        }
      },
      outputSchema: {
        type: 'object',
        required: [
          'id', 'name', 'target_type', 'connection_status', 'metadata',
          'issue_summary', 'created_at', 'updated_at'
        ],
        additionalProperties: false,
        properties: {
          ...targetSummarySchema.properties,
          metadata: { type: 'object' },
          last_seen_at: { type: 'string' },
          issue_summary: {
            type: 'object',
            required: ['total', 'active', 'recovering', 'critical', 'warning', 'info'],
            additionalProperties: false,
            properties: {
              total: { type: 'integer' },
              active: { type: 'integer' },
              recovering: { type: 'integer' },
              critical: { type: 'integer' },
              warning: { type: 'integer' },
              info: { type: 'integer' }
            }
          }
        }
      }
    }, timeoutMs),
    readTool({
      name: 'list_target_issues',
      description: 'List normalized issues for one target available to this Agent. By default, returns active and recovering issues.',
      inputSchema: {
        type: 'object',
        required: ['target_id'],
        additionalProperties: false,
        properties: {
          target_id: { type: 'string', minLength: 1, maxLength: 256 },
          q: { type: 'string', maxLength: 200 },
          status: { enum: ['active', 'recovering', 'resolved', 'all'] },
          severity: { enum: ['critical', 'warning', 'info'] },
          limit: { type: 'integer', minimum: 1, maximum: 25 },
          cursor: { type: 'string', maxLength: 4096 }
        }
      },
      outputSchema: {
        type: 'object',
        required: ['items'],
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: issueSchema },
          next_cursor: { type: 'string' }
        }
      }
    }, timeoutMs)
  ];
}

export function isAgentTargetsMcpToolName(value: string): value is AgentTargetsMcpToolName {
  return AGENT_TARGETS_MCP_TOOL_NAMES.includes(value as AgentTargetsMcpToolName);
}

export function isAgentTargetsMcpInstallation(
  installation: Pick<AgentMcpInstallationSnapshot, 'name' | 'url'>,
  builtinServerUrl: string
): boolean {
  return installation.name === AGENT_TARGETS_MCP_SERVER_NAME
    && installation.url === builtinServerUrl;
}
