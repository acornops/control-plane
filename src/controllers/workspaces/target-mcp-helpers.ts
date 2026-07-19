import { Response } from 'express';

import { McpServerConfig } from '../../services/mcp-registry-client.js';

export type TargetMcpAuthInput = {
  type?: 'none' | 'bearer_token' | 'custom_header';
  headerName?: string;
  headerPrefix?: string;
};

export function parseTargetMcpAuth(
  value: unknown,
  options: { defaultToNone?: boolean } = {}
): { auth?: TargetMcpAuthInput; sharedCredentialProvided: boolean } {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!raw) {
    return {
      auth: options.defaultToNone ? { type: 'none' } : undefined,
      sharedCredentialProvided: false
    };
  }
  const type = raw.type === 'bearer_token' || raw.type === 'custom_header' || raw.type === 'none'
    ? raw.type
    : options.defaultToNone
      ? 'none'
      : undefined;
  return {
    auth: {
      type,
      headerName: typeof raw.headerName === 'string' ? raw.headerName : undefined,
      headerPrefix: typeof raw.headerPrefix === 'string' ? raw.headerPrefix : undefined
    },
    sharedCredentialProvided: 'secretName' in raw || 'secretValue' in raw || 'credential' in raw
  };
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
    ['headerPrefix', previous.auth_header_prefix || null, next.auth_header_prefix || null]
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
