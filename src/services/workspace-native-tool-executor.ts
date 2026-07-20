import { observeWorkspaceNativeToolCall } from '../metrics.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
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
import { digestBindings, digestPrompt, promptResourceRegistry } from './prompt-resources/index.js';

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

async function readPromptResources(run: WorkflowRunRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (digestPrompt(run.prompt) !== run.promptDigest
    || digestBindings(run.compiledAccessScope.resourceBindings) !== run.bindingDigest) {
    throw new WorkspaceNativeToolExecutionError(
      'PROMPT_RESOURCE_INTEGRITY_FAILED',
      'The run prompt resource snapshot failed integrity verification.',
      409
    );
  }
  const bindingIds = [...new Set(strings(args.bindingIds))];
  if (bindingIds.length === 0 || bindingIds.length > 20) {
    throw new WorkspaceNativeToolExecutionError('PROMPT_RESOURCE_INPUT_INVALID', 'Provide between 1 and 20 binding IDs.');
  }
  const bindings = bindingIds.map((bindingId) => {
    const binding = run.compiledAccessScope.resourceBindings.find((candidate) => candidate.bindingId === bindingId);
    if (!binding) throw new WorkspaceNativeToolExecutionError('PROMPT_RESOURCE_NOT_GRANTED', 'A requested binding is not granted to this run.', 403);
    if (binding.contextMode !== 'tool') {
      throw new WorkspaceNativeToolExecutionError('PROMPT_RESOURCE_NOT_READABLE', 'A requested binding is not tool-readable.', 403);
    }
    if (!binding.operations.includes('read')) {
      throw new WorkspaceNativeToolExecutionError('PROMPT_RESOURCE_NOT_READABLE', 'A requested binding does not grant read access.', 403);
    }
    return binding;
  });
  const maximumBytes = 256 * 1024;
  const perResourceBytes = Math.max(4_096, Math.floor(maximumBytes / bindings.length));
  const resources: Array<Record<string, unknown>> = [];
  let aggregateBytes = 0;
  for (const binding of bindings) {
    const provider = promptResourceRegistry.provider(binding.type);
    if (!provider || provider.descriptor().provider !== binding.provider || !provider.loadContext) {
      throw new WorkspaceNativeToolExecutionError('PROMPT_RESOURCE_READER_UNAVAILABLE', 'A requested binding cannot provide readable context.', 409);
    }
    const context = await provider.loadContext(binding, { runId: run.id, maximumBytes: perResourceBytes });
    if (Buffer.byteLength(JSON.stringify(context), 'utf8') > perResourceBytes) {
      throw new WorkspaceNativeToolExecutionError('PROMPT_RESOURCE_RESULT_TOO_LARGE', 'A prompt resource exceeded its context limit.', 413);
    }
    const result = {
      bindingId: binding.bindingId,
      provider: binding.provider,
      resourceId: binding.resourceId,
      labelSnapshot: binding.labelSnapshot,
      retrievedAt: new Date().toISOString(),
      context
    };
    aggregateBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (aggregateBytes > maximumBytes) break;
    resources.push(result);
  }
  return { resources, truncated: resources.length < bindings.length };
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
    if (tool.id === 'prompt.resources.read') {
      if (!('executionId' in input.run)) {
        throw new WorkspaceNativeToolExecutionError(
          'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED',
          'Reading prompt resources is available only to workflow runs.',
          403
        );
      }
      result = await readPromptResources(input.run, input.arguments);
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
