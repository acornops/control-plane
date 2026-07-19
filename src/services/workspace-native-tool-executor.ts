import { db } from '../infra/db.js';
import { observeWorkspaceNativeToolCall } from '../metrics.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import { repo } from '../store/repository.js';
import {
  createTargetRunReport,
  createWorkflowReport,
  type WorkflowReportRecord,
  WorkflowReportError
} from '../store/repository-workflow-reports.js';
import type { WorkflowRunRecord } from '../store/repository-workflows.js';
import type { Run } from '../types/domain.js';
import { config } from '../config.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';

export class WorkspaceNativeToolExecutionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'WorkspaceNativeToolExecutionError';
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function selectedChatIds(value: unknown, selected = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const mention = /^@chat\[([^\]]+)\]$/.exec(value.trim());
    selected.add(mention ? mention[1] : value.trim());
  } else if (Array.isArray(value)) {
    value.forEach((item) => selectedChatIds(item, selected));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => selectedChatIds(item, selected));
  }
  selected.delete('');
  return selected;
}

async function readSelectedChats(run: WorkflowRunRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!run.compiledAccessScope.contextGrants.includes('selected_chat_sessions')) {
    throw new WorkspaceNativeToolExecutionError(
      'SELECTED_CHAT_CONTEXT_GRANT_REQUIRED',
      'Reading selected chats requires the selected_chat_sessions context grant.',
      403
    );
  }
  const sessionIds = [...new Set(strings(args.sessionIds))];
  if (sessionIds.length === 0 || sessionIds.length > 20) {
    throw new WorkspaceNativeToolExecutionError('SELECTED_CHAT_INPUT_INVALID', 'Provide between 1 and 20 selected session IDs.');
  }
  const execution = await db.query<{ input_context: Record<string, unknown> }>(
    'SELECT input_context FROM workflow_executions WHERE id=$1', [run.executionId]
  );
  const granted = selectedChatIds(execution.rows[0]?.input_context || {});
  if (sessionIds.some((sessionId) => !granted.has(sessionId))) {
    throw new WorkspaceNativeToolExecutionError(
      'SELECTED_CHAT_NOT_GRANTED',
      'A requested chat session was not explicitly selected for this workflow run.',
      403
    );
  }
  const sessions: Array<Record<string, unknown>> = [];
  for (const sessionId of sessionIds) {
    const session = await repo.getSession(sessionId);
    if (!session || session.workspaceId !== run.workspaceId) {
      throw new WorkspaceNativeToolExecutionError('SELECTED_CHAT_NOT_FOUND', 'Selected chat session not found.', 404);
    }
    const messages = await repo.listMessages(sessionId, { limit: 200 });
    sessions.push({
      id: session.id,
      targetId: session.targetId,
      targetType: session.targetType,
      messages: messages.items.map((message) => ({
        id: message.id, role: message.role, content: message.content, createdAt: message.createdAt
      }))
    });
  }
  return { sessions };
}

async function generatePdf(
  run: WorkflowRunRecord | Run,
  args: Record<string, unknown>,
  toolCallId: string
): Promise<Record<string, unknown>> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  if (!title || title.length > 200 || !markdown) {
    throw new WorkspaceNativeToolExecutionError('REPORT_SOURCE_INVALID', 'A title and non-empty markdown source are required.');
  }
  const workflowRun = 'executionId' in run;
  const retentionDays = config.TARGET_CHAT_REPORT_RETENTION_DAYS;
  const provenance = args.provenance && typeof args.provenance === 'object' && !Array.isArray(args.provenance)
    ? args.provenance as Record<string, unknown>
    : {};
  if (Buffer.byteLength(JSON.stringify(provenance), 'utf8') > 32_768) {
    throw new WorkspaceNativeToolExecutionError('REPORT_PROVENANCE_TOO_LARGE', 'Report provenance exceeds the allowed size.', 413);
  }
  let report: WorkflowReportRecord;
  try {
    report = workflowRun
      ? await createWorkflowReport({
          workspaceId: run.workspaceId,
          executionId: run.executionId,
          runId: run.id,
          toolCallId,
          title,
          source: { markdown },
          provenance: {
            ...provenance,
            workflowId: run.workflowId,
            workflowRunId: run.workflowRunId,
            runId: run.id,
            toolCallId
          },
          retentionDays
        })
      : await createTargetRunReport({
          workspaceId: run.workspaceId,
          targetRunId: run.id,
          toolCallId,
          title,
          source: { markdown },
          provenance: {
            ...provenance,
            targetId: run.targetId,
            targetType: run.targetType,
            sessionId: run.sessionId,
            runId: run.id,
            toolCallId
          },
          retentionDays
        });
  } catch (error) {
    if (error instanceof WorkflowReportError) {
      const status = error.code === 'REPORT_RENDER_TIMEOUT' ? 504 : 413;
      throw new WorkspaceNativeToolExecutionError(error.code, 'The report could not be created within artifact limits.', status);
    }
    throw error;
  }
  return {
    reportId: report.id,
    title: report.title,
    mediaType: report.mediaType,
    sourceSizeBytes: report.sourceSizeBytes,
    retentionExpiresAt: report.retentionExpiresAt,
    downloadUrl: `/api/v1/report-artifacts/${encodeURIComponent(report.id)}/download`
  };
}

export async function executeWorkspaceNativeTool(input: {
  run: WorkflowRunRecord | Run;
  toolId: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const tool = getWorkspaceNativeTool(input.toolId);
  if (!tool) throw new WorkspaceNativeToolExecutionError('NATIVE_TOOL_NOT_FOUND', 'Native tool not found.', 404);
  if (!input.toolCallId) throw new WorkspaceNativeToolExecutionError('TOOL_CALL_ID_REQUIRED', 'toolCallId is required.');
  const startedAt = Date.now();
  try {
    let result: Record<string, unknown>;
    if (tool.id === 'chat.sessions.read_selected') {
      if (!('executionId' in input.run)) {
        throw new WorkspaceNativeToolExecutionError(
          'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED',
          'Reading selected chats is available only to workflow runs.',
          403
        );
      }
      result = await readSelectedChats(input.run, input.arguments);
    }
    else if (tool.id === 'reports.pdf.generate') result = await generatePdf(input.run, input.arguments, input.toolCallId);
    else throw new WorkspaceNativeToolExecutionError('NATIVE_TOOL_NOT_IMPLEMENTED', 'Native tool is not implemented.', 501);

    await recordWorkspaceAuditEvent({
      workspaceId: input.run.workspaceId,
      category: 'tool',
      eventType: 'workspace_native_tool.called.v1',
      operation: tool.auditOperation,
      actorType: 'system',
      objectType: 'tool_call',
      objectId: `${input.run.id}:${input.toolCallId}`,
      objectName: tool.id,
      summary: 'Workspace native tool called',
      metadata: {
        toolId: tool.id,
        authorizationClass: tool.authorizationClass,
        runId: input.run.id,
        ...('workflowId' in input.run ? { workflowId: input.run.workflowId } : {
          targetId: input.run.targetId,
          targetType: input.run.targetType,
          sessionId: input.run.sessionId
        }),
        durationMs: Date.now() - startedAt,
        succeeded: true
      }
    });
    observeWorkspaceNativeToolCall(tool.id, 'success', Date.now() - startedAt);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
  } catch (error) {
    observeWorkspaceNativeToolCall(tool.id, 'failure', Date.now() - startedAt);
    await recordWorkspaceAuditEvent({
      workspaceId: input.run.workspaceId,
      category: 'tool',
      eventType: 'workspace_native_tool.failed.v1',
      operation: tool.auditOperation,
      actorType: 'system',
      objectType: 'tool_call',
      objectId: `${input.run.id}:${input.toolCallId}`,
      objectName: tool.id,
      summary: 'Workspace native tool failed',
      metadata: {
        toolId: tool.id,
        authorizationClass: tool.authorizationClass,
        runId: input.run.id,
        ...('workflowId' in input.run ? { workflowId: input.run.workflowId } : {
          targetId: input.run.targetId,
          targetType: input.run.targetType,
          sessionId: input.run.sessionId
        }),
        durationMs: Date.now() - startedAt,
        succeeded: false,
        errorCode: error instanceof WorkspaceNativeToolExecutionError ? error.code : 'NATIVE_TOOL_EXECUTION_FAILED'
      }
    });
    throw error;
  }
}
