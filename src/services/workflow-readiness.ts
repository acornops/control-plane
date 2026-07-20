import type { RunPrincipalRef } from '../types/agents.js';
import type { TargetSummary } from '../types/domain.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';
import {
  checkMcpReadiness,
  type McpReadinessFailureCode,
  type McpReadinessResult
} from './mcp-registry-client.js';

export type McpReadinessAction = 'connect_mcp_server' | 'verify_mcp_server';

export interface PublicMcpReadinessFailure {
  serverId: string;
  toolName: string;
  code: McpReadinessFailureCode;
  action?: McpReadinessAction;
}

export interface McpReadinessReport {
  errors: string[];
  failures: PublicMcpReadinessFailure[];
}

const MAX_PUBLIC_READINESS_FAILURES = 20;
const MAX_PUBLIC_READINESS_IDENTIFIER_LENGTH = 256;

function boundedIdentifier(value: string): string {
  return value.slice(0, MAX_PUBLIC_READINESS_IDENTIFIER_LENGTH);
}

function publicFailureCode(value: unknown): McpReadinessFailureCode {
  switch (value) {
    case 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED':
    case 'MCP_CONNECTION_MISSING':
    case 'MCP_CONNECTION_ERROR':
    case 'MCP_CREDENTIAL_TOOL_UNAVAILABLE':
    case 'MCP_INSTALLATION_UNAVAILABLE':
    case 'MCP_REMOTE_DISABLED':
      return value;
    default:
      return 'MCP_INSTALLATION_UNAVAILABLE';
  }
}

function readinessFailureMessage(failure: PublicMcpReadinessFailure): string {
  switch (failure.code) {
    case 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED':
      return `${failure.code}: individual MCP tool ${failure.serverId}/${failure.toolName} requires a user principal.`;
    case 'MCP_CONNECTION_MISSING':
      return `Connect a credential for MCP tool ${failure.serverId}/${failure.toolName}.`;
    case 'MCP_CONNECTION_ERROR':
      return `Verify or replace the credential for MCP tool ${failure.serverId}/${failure.toolName}.`;
    case 'MCP_CREDENTIAL_TOOL_UNAVAILABLE':
      return `The connected credential does not expose approved MCP tool ${failure.serverId}/${failure.toolName}.`;
    case 'MCP_REMOTE_DISABLED':
      return `Remote MCP is disabled for tool ${failure.serverId}/${failure.toolName}.`;
    default:
      return `Exact MCP tool ${failure.serverId}/${failure.toolName} is unavailable.`;
  }
}

function readinessFailureAction(
  failure: McpReadinessResult['failures'][number]
): McpReadinessAction | undefined {
  if (failure.action === 'connect_mcp_server' || failure.action === 'verify_mcp_server') {
    return failure.action;
  }
  switch (failure.code) {
    case 'MCP_CONNECTION_MISSING':
      return 'connect_mcp_server';
    case 'MCP_CONNECTION_ERROR':
    case 'MCP_CREDENTIAL_TOOL_UNAVAILABLE':
      return 'verify_mcp_server';
    default:
      return undefined;
  }
}

function publicReadinessFailure(
  failure: McpReadinessResult['failures'][number]
): PublicMcpReadinessFailure {
  const action = readinessFailureAction(failure);
  return {
    serverId: boundedIdentifier(failure.server_id),
    toolName: boundedIdentifier(failure.tool_name),
    code: publicFailureCode(failure.code),
    ...(action ? { action } : {})
  };
}

export function publicMcpReadinessCode(report: McpReadinessReport): string {
  switch (report.failures[0]?.code) {
    case 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED':
    case 'MCP_INSTALLATION_UNAVAILABLE':
    case 'MCP_REMOTE_DISABLED':
      return report.failures[0].code;
    default:
      return 'MCP_CONNECTION_REQUIRED';
  }
}

export function publicMcpReadinessError(report: McpReadinessReport): {
  code: string;
  message: string;
  retryable: false;
  details: {
    readinessFailures: PublicMcpReadinessFailure[];
    action?: McpReadinessAction;
  };
} {
  const action = report.failures[0]?.action;
  return {
    code: publicMcpReadinessCode(report),
    message: report.errors[0] || 'MCP prerequisites are not ready.',
    retryable: false,
    details: {
      readinessFailures: report.failures,
      ...(action ? { action } : {})
    }
  };
}

export async function getExactMcpReadinessReport(
  workspaceId: string,
  principal: RunPrincipalRef,
  refs: Array<{ serverId: string; toolName: string }>
): Promise<McpReadinessReport> {
  if (refs.length === 0) return { errors: [], failures: [] };
  const result = await checkMcpReadiness({
    workspaceId,
    principal,
    toolRefs: refs
  });
  const failures = result.failures
    .slice(0, MAX_PUBLIC_READINESS_FAILURES)
    .map(publicReadinessFailure);
  return {
    errors: failures.map(readinessFailureMessage),
    failures
  };
}

export async function getExactMcpReadinessErrors(
  workspaceId: string,
  principal: RunPrincipalRef,
  refs: Array<{ serverId: string; toolName: string }>
): Promise<string[]> {
  return (await getExactMcpReadinessReport(workspaceId, principal, refs)).errors;
}

export async function getWorkflowCapabilityReadinessReport(
  workspaceId: string,
  scope: CompiledWorkflowAccessScope,
  target?: TargetSummary,
  context: { actorUserId?: string; principal?: RunPrincipalRef } = {}
): Promise<McpReadinessReport> {
  const exactToolRefs = [...(scope.mcpTools || []), ...(scope.targetToolRefs || [])]
    .filter((ref, index, refs) => refs.findIndex((candidate) => (
      candidate.serverId === ref.serverId && candidate.toolName === ref.toolName
    )) === index);
  const principal = context.principal
    || (context.actorUserId ? { type: 'user' as const, id: context.actorUserId } : undefined);
  if (!principal && exactToolRefs.length > 0) {
    return {
      errors: ['MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED: exact MCP tools require a run principal.'],
      failures: exactToolRefs.slice(0, MAX_PUBLIC_READINESS_FAILURES).map((ref) => ({
        serverId: boundedIdentifier(ref.serverId),
        toolName: boundedIdentifier(ref.toolName),
        code: 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED'
      }))
    };
  }
  return principal
    ? getExactMcpReadinessReport(workspaceId, principal, exactToolRefs)
    : { errors: [], failures: [] };
}

export async function getWorkflowCapabilityReadinessErrors(
  workspaceId: string,
  scope: CompiledWorkflowAccessScope,
  target?: TargetSummary,
  context: { actorUserId?: string; principal?: RunPrincipalRef } = {}
): Promise<string[]> {
  return (await getWorkflowCapabilityReadinessReport(
    workspaceId,
    scope,
    target,
    context
  )).errors;
}

export async function getTargetMcpConnectionReadinessReport(
  workspaceId: string,
  actorUserId: string,
  refs: Array<{ serverId: string; toolName: string }>
): Promise<McpReadinessReport> {
  return getExactMcpReadinessReport(
    workspaceId,
    { type: 'user', id: actorUserId },
    refs
  );
}

export async function getTargetMcpConnectionReadinessErrors(
  workspaceId: string,
  actorUserId: string,
  refs: Array<{ serverId: string; toolName: string }>
): Promise<string[]> {
  return (await getTargetMcpConnectionReadinessReport(
    workspaceId,
    actorUserId,
    refs
  )).errors;
}
