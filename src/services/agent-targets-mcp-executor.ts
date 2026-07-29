import { repo } from '../store/repository.js';
import type { AgentDefinition } from '../types/agents.js';
import type { TargetIssue, TargetIssueSeverity, TargetIssueStatus } from '../types/target-issues.js';
import type { TargetSummary, TargetType } from '../types/domain.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery
} from '../utils/pagination.js';
import {
  type AgentTargetsMcpToolName
} from './agent-targets-mcp-catalog.js';
import { targetAllowedByAgentScope } from './target-scope-authorization.js';

const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_ENTRIES_PER_CONTAINER = 50;
const MAX_METADATA_TOTAL_ENTRIES = 100;
const MAX_METADATA_TOTAL_CHARS = 20_000;
const MAX_METADATA_STRING_CHARS = 1000;
const TOOL_ARGUMENTS: Record<AgentTargetsMcpToolName, ReadonlySet<string>> = {
  list_targets: new Set(['q', 'target_type', 'limit', 'cursor']),
  get_target: new Set(['target_id']),
  list_target_issues: new Set(['target_id', 'q', 'status', 'severity', 'limit', 'cursor'])
};

export class AgentTargetsMcpExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'AgentTargetsMcpExecutionError';
  }
}

interface MetadataBudget {
  entries: number;
  chars: number;
}

function boundedString(value: string, budget: MetadataBudget, maxChars = MAX_METADATA_STRING_CHARS): string {
  const length = Math.min(value.length, maxChars, budget.chars);
  budget.chars -= length;
  return value.slice(0, length);
}

function boundedMetadata(
  value: unknown,
  depth = 0,
  budget: MetadataBudget = { entries: MAX_METADATA_TOTAL_ENTRIES, chars: MAX_METADATA_TOTAL_CHARS }
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedString(value, budget);
  if (depth >= MAX_METADATA_DEPTH) return '[omitted: maximum depth]';
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value.slice(0, MAX_METADATA_ENTRIES_PER_CONTAINER)) {
      if (budget.entries <= 0 || budget.chars <= 0) break;
      budget.entries -= 1;
      result.push(boundedMetadata(item, depth + 1, budget));
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_METADATA_ENTRIES_PER_CONTAINER)) {
      if (budget.entries <= 0 || budget.chars <= 0) break;
      budget.entries -= 1;
      const boundedKey = boundedString(key, budget, 200);
      if (!boundedKey) break;
      result[boundedKey] = boundedMetadata(entry, depth + 1, budget);
    }
    return result;
  }
  return boundedString(String(value), budget);
}

function stringArgument(args: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', `${name} must be a string of at most ${maxLength} characters.`, 400);
  }
  return value.trim();
}

function requiredStringArgument(args: Record<string, unknown>, name: string, maxLength: number): string {
  const value = stringArgument(args, name, maxLength);
  if (!value) {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', `${name} is required.`, 400);
  }
  return value;
}

function limitArgument(args: Record<string, unknown>): number {
  const value = args.limit;
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 25) {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', 'limit must be an integer between 1 and 25.', 400);
  }
  return Number(value);
}

function targetTypeArgument(args: Record<string, unknown>): TargetType | undefined {
  const value = args.target_type;
  if (value === undefined) return undefined;
  if (value !== 'kubernetes' && value !== 'virtual_machine') {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', 'target_type must be kubernetes or virtual_machine.', 400);
  }
  return value;
}

function cursorArgument(args: Record<string, unknown>): string | undefined {
  return stringArgument(args, 'cursor', 4096);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function targetSummary(target: TargetSummary) {
  return {
    id: target.id,
    name: target.name,
    target_type: target.targetType,
    connection_status: target.status,
    created_at: target.createdAt,
    updated_at: target.updatedAt
  };
}

function issueSummary(issue: TargetIssue) {
  return {
    id: issue.id,
    target_id: issue.targetId,
    target_type: issue.targetType,
    issue_type: issue.issueType.slice(0, 200),
    status: issue.status,
    severity: issue.severity,
    title: issue.title.slice(0, 500),
    summary: issue.summary.slice(0, 2000),
    ...(issue.scopeKind ? { scope_kind: issue.scopeKind.slice(0, 200) } : {}),
    ...(issue.scopeName ? { scope_name: issue.scopeName.slice(0, 500) } : {}),
    ...(issue.namespace ? { namespace: issue.namespace.slice(0, 500) } : {}),
    ...(issue.objectKind ? { object_kind: issue.objectKind.slice(0, 200) } : {}),
    ...(issue.objectName ? { object_name: issue.objectName.slice(0, 500) } : {}),
    ...(issue.reason ? { reason: issue.reason.slice(0, 1000) } : {}),
    first_seen_at: issue.firstSeenAt,
    last_seen_at: issue.lastSeenAt,
    last_observed_snapshot_at: issue.lastObservedSnapshotAt,
    occurrence_count: issue.occurrenceCount,
    reopened_count: issue.reopenedCount
  };
}

function mcpResult(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false
  };
}

async function scopedTarget(
  workspaceId: string,
  agent: AgentDefinition,
  targetId: string
): Promise<TargetSummary> {
  const target = await repo.getTarget(workspaceId, targetId);
  if (!target || !targetAllowedByAgentScope(agent.targetScope, { id: target.id, targetType: target.targetType })) {
    throw new AgentTargetsMcpExecutionError('TARGET_NOT_FOUND', 'Target not found within this Agent target scope.', 404);
  }
  return target;
}

async function listTargets(
  workspaceId: string,
  agent: AgentDefinition,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const q = normalizeSearchQuery(stringArgument(args, 'q', 200));
  const targetType = targetTypeArgument(args);
  const allowedTargetTypes = agent.targetScope.targetTypes || [];
  const allowedTargetIds = agent.targetScope.targetIds || [];
  if (
    agent.targetScope.type === 'selected_target'
    && allowedTargetTypes.length === 0
    && allowedTargetIds.length === 0
  ) {
    return mcpResult({ items: [] });
  }
  if (targetType && allowedTargetTypes.length && !allowedTargetTypes.includes(targetType)) {
    return mcpResult({ items: [] });
  }
  const signature = makeQuerySignature({
    q,
    targetType,
    allowedTargetTypes,
    allowedTargetIds
  });
  let cursor;
  try {
    cursor = decodeCursor<{ createdAt: string; targetId: string; signature: string }>(
      cursorArgument(args),
      signature
    );
    if (cursor && (!validTimestamp(cursor.createdAt) || typeof cursor.targetId !== 'string' || !cursor.targetId)) {
      throw new CursorMismatchError();
    }
  } catch (error) {
    if (error instanceof CursorMismatchError) {
      throw new AgentTargetsMcpExecutionError('INVALID_CURSOR', error.message, 400);
    }
    throw error;
  }
  const page = await repo.listTargets(workspaceId, {
    limit: limitArgument(args),
    cursor,
    q,
    targetType,
    allowedTargetTypes,
    allowedTargetIds,
    signature
  });
  return mcpResult({
    items: page.items.map(targetSummary),
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {})
  });
}

async function getTarget(
  workspaceId: string,
  agent: AgentDefinition,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const target = await scopedTarget(workspaceId, agent, requiredStringArgument(args, 'target_id', 256));
  const [registration, issues] = await Promise.all([
    repo.getTargetAgentRegistration(target.id),
    repo.summarizeTargetIssues(workspaceId, target.id)
  ]);
  return mcpResult({
    ...targetSummary(target),
    metadata: boundedMetadata(target.metadata) as Record<string, unknown>,
    ...(registration?.lastSeenAt ? { last_seen_at: registration.lastSeenAt } : {}),
    issue_summary: issues
  });
}

function issueStatusArgument(args: Record<string, unknown>): TargetIssueStatus | 'all' | undefined {
  const value = args.status;
  if (value === undefined) return undefined;
  if (value !== 'active' && value !== 'recovering' && value !== 'resolved' && value !== 'all') {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', 'status must be active, recovering, resolved, or all.', 400);
  }
  return value;
}

function issueSeverityArgument(args: Record<string, unknown>): TargetIssueSeverity | undefined {
  const value = args.severity;
  if (value === undefined) return undefined;
  if (value !== 'critical' && value !== 'warning' && value !== 'info') {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', 'severity must be critical, warning, or info.', 400);
  }
  return value;
}

async function listTargetIssues(
  workspaceId: string,
  agent: AgentDefinition,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const target = await scopedTarget(workspaceId, agent, requiredStringArgument(args, 'target_id', 256));
  const q = normalizeSearchQuery(stringArgument(args, 'q', 200));
  const status = issueStatusArgument(args);
  const severity = issueSeverityArgument(args);
  const signature = makeQuerySignature({ targetId: target.id, q, status, severity });
  let cursor;
  try {
    cursor = decodeCursor<{
      statusRank: number;
      severityRank: number;
      lastSeenAt: string;
      issueId: string;
      signature: string;
    }>(cursorArgument(args), signature);
    if (cursor && (
      !Number.isInteger(cursor.statusRank)
      || cursor.statusRank < 0
      || cursor.statusRank > 2
      || !Number.isInteger(cursor.severityRank)
      || cursor.severityRank < 0
      || cursor.severityRank > 2
      || !validTimestamp(cursor.lastSeenAt)
      || typeof cursor.issueId !== 'string'
      || !cursor.issueId
    )) {
      throw new CursorMismatchError();
    }
  } catch (error) {
    if (error instanceof CursorMismatchError) {
      throw new AgentTargetsMcpExecutionError('INVALID_CURSOR', error.message, 400);
    }
    throw error;
  }
  const page = await repo.listTargetIssues(workspaceId, target.id, {
    limit: limitArgument(args),
    cursor,
    signature,
    q,
    status,
    severity
  });
  return mcpResult({
    items: page.items.map(issueSummary),
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {})
  });
}

export async function executeAgentTargetsMcpTool(input: {
  workspaceId: string;
  agent: AgentDefinition;
  toolName: AgentTargetsMcpToolName;
  arguments: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    throw new AgentTargetsMcpExecutionError('TOOL_ARGS_INVALID', 'arguments must be an object.', 400);
  }
  const unknownArgument = Object.keys(input.arguments)
    .find((name) => !TOOL_ARGUMENTS[input.toolName].has(name));
  if (unknownArgument) {
    throw new AgentTargetsMcpExecutionError(
      'TOOL_ARGS_INVALID',
      `Unknown argument: ${unknownArgument}.`,
      400
    );
  }
  if (input.toolName === 'list_targets') {
    return listTargets(input.workspaceId, input.agent, input.arguments);
  }
  if (input.toolName === 'get_target') {
    return getTarget(input.workspaceId, input.agent, input.arguments);
  }
  return listTargetIssues(input.workspaceId, input.agent, input.arguments);
}
