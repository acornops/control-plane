import { observeWorkspaceNativeToolCall } from '../metrics.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import {
  createConversationDocument,
  createWorkflowDocument,
  type GeneratedDocumentRecord,
  GeneratedDocumentError
} from '../store/repository-generated-documents.js';
import type { WorkflowRunRecord } from '../store/repository-workflows.js';
import type { Run } from '../types/domain.js';
import { config } from '../config.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';
import {
  assertFetchUrlAllowed,
  FETCH_TOOL_ID,
  FetchUrlPolicyError,
  normalizeFetchToolInput,
  normalizeFetchToolConfig
} from './fetch-url-policy.js';
import { fetchPublicHttpGet, FetchHttpError } from './fetch-http.js';

export class WorkspaceNativeToolExecutionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'WorkspaceNativeToolExecutionError';
  }
}

async function createDocument(
  run: WorkflowRunRecord | Run,
  args: Record<string, unknown>,
  toolCallId: string
): Promise<Record<string, unknown>> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const format = args.format === undefined ? 'pdf' : args.format;
  if (!title || title.length > 200 || !markdown) {
    throw new WorkspaceNativeToolExecutionError('DOCUMENT_SOURCE_INVALID', 'A title and non-empty markdown source are required.');
  }
  if (format !== 'pdf' && format !== 'markdown') {
    throw new WorkspaceNativeToolExecutionError('DOCUMENT_FORMAT_INVALID', 'Document format must be pdf or markdown.');
  }
  const workflowRun = 'executionId' in run;
  const retentionDays = config.GENERATED_DOCUMENT_RETENTION_DAYS;
  let document: GeneratedDocumentRecord;
  try {
    document = workflowRun
      ? await createWorkflowDocument({
          workspaceId: run.workspaceId,
          executionId: run.executionId,
          runId: run.id,
          toolCallId,
          title,
          mediaType: format === 'pdf' ? 'application/pdf' : 'text/markdown',
          source: { markdown },
          provenance: {
            workflowId: run.workflowId,
            executionId: run.executionId,
            runId: run.id,
            toolCallId
          },
          retentionDays
        })
      : await createConversationDocument({
          workspaceId: run.workspaceId,
          conversationRunId: run.id,
          toolCallId,
          title,
          mediaType: format === 'pdf' ? 'application/pdf' : 'text/markdown',
          source: { markdown },
          provenance: {
            ...(run.conversationKind === 'agent_chat'
              ? { agentId: run.agentId, conversationKind: 'agent_chat' }
              : { targetId: run.targetId, targetType: run.targetType }),
            sessionId: run.sessionId,
            runId: run.id,
            toolCallId
          },
          retentionDays
        });
  } catch (error) {
    if (error instanceof GeneratedDocumentError) {
      const status = error.code === 'REPORT_RENDER_TIMEOUT' ? 504 : 413;
      throw new WorkspaceNativeToolExecutionError(error.code, 'The document could not be created within artifact limits.', status);
    }
    throw error;
  }
  return {
    documentId: document.id,
    title: document.title,
    mediaType: document.mediaType,
    sourceSizeBytes: document.sourceSizeBytes,
    retentionExpiresAt: document.retentionExpiresAt,
    downloadUrl: `/api/v1/generated-documents/${encodeURIComponent(document.id)}/download`
  };
}

async function fetchExternalUrl(
  run: WorkflowRunRecord | Run,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    if (!run.compiledAccessScope) {
      throw new WorkspaceNativeToolExecutionError('RUN_SCOPE_INVALID', 'The run is missing its compiled Agent capability scope.', 409);
    }
    const { url: rawUrl } = normalizeFetchToolInput(args);
    const config = normalizeFetchToolConfig(run.compiledAccessScope.nativeToolConfigs?.[FETCH_TOOL_ID]);
    const canonicalUrl = assertFetchUrlAllowed(rawUrl, config);
    return await fetchPublicHttpGet(canonicalUrl) as unknown as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FetchUrlPolicyError) {
      const status = error.code === 'FETCH_URL_NOT_ALLOWED' ? 403 : 400;
      throw new WorkspaceNativeToolExecutionError(error.code, error.message, status);
    }
    if (error instanceof FetchHttpError) {
      throw new WorkspaceNativeToolExecutionError(error.code, error.message, error.status);
    }
    throw error;
  }
}

function fetchAuditMetadata(
  toolId: string,
  args: Record<string, unknown>,
  result?: Record<string, unknown>
): Record<string, unknown> {
  if (toolId !== FETCH_TOOL_ID) return {};
  const rawUrl = typeof args.url === 'string' ? args.url : '';
  let hostname: string | undefined;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    // Invalid URLs are represented by the error code without logging request content.
  }
  const status = typeof result?.status === 'number' ? result.status : undefined;
  return {
    ...(hostname ? { hostname } : {}),
    ...(status ? { statusClass: `${Math.floor(status / 100)}xx` } : {}),
    ...(typeof result?.responseSizeBytes === 'number'
      ? { responseSizeBytes: result.responseSizeBytes }
      : {})
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
    if (tool.id === FETCH_TOOL_ID) {
      if (!('executionId' in input.run) && input.run.conversationKind !== 'agent_chat') {
        throw new WorkspaceNativeToolExecutionError(
          'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED',
          'Fetch is available only to Agent-owned runs.',
          403
        );
      }
      result = await fetchExternalUrl(input.run, input.arguments);
    }
    else if (tool.id === 'documents.create') result = await createDocument(input.run, input.arguments, input.toolCallId);
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
        ...('workflowId' in input.run ? { workflowId: input.run.workflowId } : input.run.conversationKind === 'agent_chat'
          ? { agentId: input.run.agentId, sessionId: input.run.sessionId }
          : { targetId: input.run.targetId, targetType: input.run.targetType, sessionId: input.run.sessionId }),
        durationMs: Date.now() - startedAt,
        succeeded: true,
        ...fetchAuditMetadata(tool.id, input.arguments, result)
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
        ...('workflowId' in input.run ? { workflowId: input.run.workflowId } : input.run.conversationKind === 'agent_chat'
          ? { agentId: input.run.agentId, sessionId: input.run.sessionId }
          : { targetId: input.run.targetId, targetType: input.run.targetType, sessionId: input.run.sessionId }),
        durationMs: Date.now() - startedAt,
        succeeded: false,
        errorCode: error instanceof WorkspaceNativeToolExecutionError ? error.code : 'NATIVE_TOOL_EXECUTION_FAILED',
        ...fetchAuditMetadata(tool.id, input.arguments)
      }
    });
    throw error;
  }
}
