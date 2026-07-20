import { Response } from 'express';
import { z } from 'zod';

import { McpServerConfig } from '../../services/mcp-registry-client.js';

const targetMcpAuthSchema = z.object({
  type: z.enum(['none', 'bearer_token', 'custom_header']),
  headerName: z.string().min(1).optional(),
  headerPrefix: z.string().optional()
}).strict();

const targetMcpToolSchema = z.object({
  name: z.string().trim().min(1),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  description: z.string().optional(),
  capability: z.enum(['read', 'write']).optional(),
  version: z.string().optional(),
  source: z.enum(['mcp', 'builtin']).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  artifactPolicy: z.enum(['never', 'if_detailed', 'always']).optional(),
  enabled: z.boolean().optional()
}).strict();

const targetMcpCreateSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string(), z.string()).optional(),
  auth: targetMcpAuthSchema.optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional()
}).strict();

const targetMcpUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  publicHeaders: z.record(z.string(), z.string()).optional(),
  auth: targetMcpAuthSchema.optional(),
  credentialMode: z.enum(['none', 'workspace', 'individual']).optional(),
  tools: z.array(targetMcpToolSchema).optional(),
  removeTools: z.array(z.string().trim().min(1)).optional(),
  expectedRevision: z.number().int().min(1).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one update field is required.');

export const targetMcpToolSettingsSchema = z.object({
  enabled: z.boolean(),
  capability: z.enum(['read', 'write']).optional()
}).strict();

export function parseTargetMcpServerCreate(value: unknown) {
  return targetMcpCreateSchema.safeParse(value);
}

export function parseTargetMcpServerUpdate(value: unknown) {
  return targetMcpUpdateSchema.safeParse(value);
}

function respondInvalidMcpPayload(res: Response, message: string): void {
  res.status(400).json({
    error: { code: 'VALIDATION_ERROR', message, retryable: false }
  });
}

export function requireTargetMcpServerCreate(value: unknown, res: Response) {
  const parsed = parseTargetMcpServerCreate(value);
  if (parsed.success) return parsed.data;
  respondInvalidMcpPayload(res, 'Invalid MCP server payload');
  return null;
}

export function requireTargetMcpServerUpdate(value: unknown, res: Response) {
  const parsed = parseTargetMcpServerUpdate(value);
  if (parsed.success) return parsed.data;
  respondInvalidMcpPayload(res, 'Invalid MCP server payload');
  return null;
}

export function requireTargetMcpToolSettings(value: unknown, res: Response) {
  const parsed = targetMcpToolSettingsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  respondInvalidMcpPayload(res, 'Invalid MCP tool settings payload');
  return null;
}

export function targetMcpTrustBoundaryChanges(
  previous: McpServerConfig | undefined,
  next: McpServerConfig
): string[] {
  if (!previous) return [];
  const fields: Array<[string, unknown, unknown]> = [
    ['effectiveUrl', previous.server_url, next.server_url],
    ['authType', previous.auth_type, next.auth_type],
    ['headerName', previous.auth_header_name || null, next.auth_header_name || null],
    ['headerPrefix', previous.auth_header_prefix || null, next.auth_header_prefix || null],
    ['credentialMode', previous.credential_mode, next.credential_mode]
  ];
  return fields.filter(([, before, after]) => before !== after).map(([name]) => name);
}

export function respondMissingMcpCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with MCP management capability can modify MCP server settings',
      retryable: false
    }
  });
}

export function respondMissingToolsCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with tool management capability can modify tool settings',
      retryable: false
    }
  });
}
