import type { ToolAccessMode } from '../types/domain.js';
import { TARGETS_MCP_SERVER_ID } from './targets-mcp.js';
import { TARGETS_MCP_CATALOG } from './targets-mcp-catalog.js';

export function isPlatformOwnedMcpServer(serverId: string): boolean {
  return serverId === TARGETS_MCP_SERVER_ID;
}

export interface WorkspaceMcpToolSpec {
  name: string;
  server_id: string;
  tool_name: string;
  description: string;
  capability: 'read' | 'write';
  input_schema: Record<string, unknown>;
}

/**
 * Resolve platform-owned MCP servers through the same server/tool reference
 * contract used by remote MCP. Provider-specific routing stays inside this
 * MCP metadata layer and never enters Agent or Workflow scope types.
 */
export async function resolveWorkspaceMcpToolSpecs(input: {
  workspaceId: string;
  runId: string;
  mode: ToolAccessMode;
  refs: Array<{ serverId: string; toolName: string }>;
}): Promise<WorkspaceMcpToolSpec[]> {
  const allowedNames = new Set(input.refs
    .filter((ref) => isPlatformOwnedMcpServer(ref.serverId))
    .map((ref) => ref.toolName));
  if (allowedNames.size === 0) return [];

  const specs = TARGETS_MCP_CATALOG.flatMap((candidate): WorkspaceMcpToolSpec[] => {
      if (!allowedNames.has(candidate.name)
        || (input.mode === 'read_only' && candidate.capability === 'write')) return [];
      const baseSchema = structuredClone(candidate.inputSchema);
      const properties = baseSchema.properties && typeof baseSchema.properties === 'object'
        && !Array.isArray(baseSchema.properties)
        ? baseSchema.properties as Record<string, unknown>
        : {};
      const required = Array.isArray(baseSchema.required)
        ? baseSchema.required.filter((value): value is string => typeof value === 'string')
        : [];
      return [{
        name: candidate.name,
        server_id: TARGETS_MCP_SERVER_ID,
        tool_name: candidate.name,
        description: `${candidate.description} Select the workspace target in this call.`,
        capability: candidate.capability,
        input_schema: {
          ...baseSchema,
          type: 'object',
          properties: {
            ...properties,
            target_id: {
              type: 'string',
              minLength: 1,
              description: 'The workspace target to use for this call.'
            },
            target_type: {
              type: 'string',
              enum: candidate.targetTypes,
              description: 'The target type. It must match the selected workspace target.'
            }
          },
          required: [...new Set([...required, 'target_id', 'target_type'])]
        }
      }];
  });
  return specs.sort((left, right) => left.name.localeCompare(right.name));
}
