import type { Response } from 'express';
import { config } from '../config.js';
import { targetAssistantContract } from '../services/target-adapter-contract.js';
import { resolveTargetRunConfirmationPolicy } from '../services/target-run-confirmation-policy.js';
import { gatewayTokenService } from '../services/token-service.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { repo } from '../store/repository.js';
import type { Run } from '../types/domain.js';
import { resolveReadyInteractiveRunTools } from './interactive-mcp-availability.js';
import { rejectUnavailableInteractiveLlm } from './interactive-llm-validation.js';
import { interactiveRunBootstrapContract } from './interactive-run-bootstrap-contract.js';

export async function bootstrapTargetRun(run: Run, res: Response): Promise<void> {
  if (!run.targetId) {
    res.status(409).json({ error: {
      code: 'TARGET_RUN_BINDING_INVALID', message: 'Target run is missing its target binding', retryable: false
    } });
    return;
  }
  const target = await repo.getTarget(run.workspaceId, run.targetId);
  if (!target) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found for run', retryable: false } });
    return;
  }
  const targetId = target.id;
  const targetSkills = await repo.getRunSkillCatalog(run.id);
  const llmSettings = await resolveWorkspaceLlmSettings(run.workspaceId, {
    provider: run.llmProvider,
    model: run.llmModel,
    reasoningSummaryMode: run.llmReasoningSummaryMode,
    reasoningEffort: run.llmReasoningEffort
  });
  if (rejectUnavailableInteractiveLlm(res, llmSettings)) return;
  const allowedProviders = llmSettings.allowedProviders;
  const allowedModels = llmSettings.allowedModels;
  if (!run.principal) {
    res.status(409).json({ error: {
      code: 'RUN_PRINCIPAL_MISSING', message: 'This run does not have a pinned principal.', retryable: false
    } });
    return;
  }
  const maxOutputTokens = config.LLM_MAX_OUTPUT_TOKENS;
  const availability = await resolveReadyInteractiveRunTools(res, {
    workspaceId: run.workspaceId,
    targetId,
    targetType: target.targetType,
    toolAccessMode: run.toolAccessMode,
    runId: run.id,
    provider: llmSettings.provider,
    principal: run.principal,
    assistantReferences: run.assistantReferences
  });
  if (!availability) return;
  const toolResolution = availability.resolution;
  const { confirmationRequiredForWrite, permissionMode } = resolveTargetRunConfirmationPolicy(
    run,
    toolResolution.confirmationRequiredForWrite
  );
  const { allowedToolSpecs, allowedToolNames, allowedToolRefs, allowedNativeTools } = toolResolution;
  const platformFunctions = toolResolution.platformFunctions.map((tool) => ({
    id: tool.id,
    model_alias: tool.modelAlias
  }));
  const allowedToolOperations = toolResolution.allowedToolOperations;
  const referencedTools = (run.assistantReferences || []).filter((reference) => reference.kind === 'tool');
  const referencedSkills = (run.assistantReferences || []).filter((reference) => reference.kind === 'skill');
  const currentToolPreviews = new Map(toolResolution.previewItems.map((tool) => [tool.name, tool]));
  const staleToolReference = referencedTools.find((reference) => {
    const current = currentToolPreviews.get(reference.id);
    if (!current) return true;
    if (!reference.serverId && !reference.toolName) return false;
    return !allowedToolSpecs.some((tool) => tool.name === reference.id
      && tool.server_id === reference.serverId
      && tool.tool_name === reference.toolName);
  });
  const skillRefById = new Map(targetSkills.map((skill) => [skill.skillId, skill.ref]));
  const staleSkillReference = referencedSkills.find((reference) => !skillRefById.has(reference.id));
  if (staleToolReference || staleSkillReference) {
    res.status(409).json({ error: {
      code: 'ASSISTANT_REFERENCE_INVALID',
      message: 'A referenced tool or skill is no longer available for this run.',
      retryable: false
    } });
    return;
  }

  const token = await gatewayTokenService.signRunScopeToken({
    runId: run.id,
    workspaceId: run.workspaceId,
    targetId,
    targetType: target.targetType,
    sessionId: run.sessionId,
    ...(run.principal.type === 'user' ? { userId: run.principal.id } : {}),
    principal: run.principal,
    permissionMode,
    allowedProviders,
    allowedTools: allowedToolNames,
    allowedToolRefs,
    allowedNativeTools,
    allowedToolOperations,
    maxOutputTokens,
    allowedModels
  });
  const runtime = interactiveRunBootstrapContract(run, llmSettings, token);
  res.status(200).json({
    contract_version: 2,
    scope: {
      workspace_id: run.workspaceId,
      target_id: targetId,
      target_type: target.targetType,
      session_id: run.sessionId,
      run_id: run.id,
      user_id: run.principal.type === 'user' ? run.principal.id : undefined
    },
    assistant: targetAssistantContract(target.targetType),
    policy: runtime.policy,
    context: runtime.context,
    llm: runtime.llm,
    tools: {
      tool_registry_version: 'trv_1',
      allowed_tools: allowedToolNames,
      allowed_tool_refs: allowedToolRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
      native_tools: allowedNativeTools,
      platform_functions: platformFunctions,
      tool_specs: allowedToolSpecs,
      referenced_tools: referencedTools.map((reference) => ({
        name: reference.id,
        label: reference.label,
        ...(reference.serverId ? { server_id: reference.serverId } : {}),
        ...(reference.toolName ? { tool_name: reference.toolName } : {})
      })),
      write_unavailable_reason: toolResolution.writeUnavailableReason,
      confirmation_required_for_write: Object.values(allowedToolOperations).includes('write')
        && confirmationRequiredForWrite,
      approval_timeout_seconds: toolResolution.approvalTimeoutSeconds,
      gateway: { url: config.LLM_GATEWAY_URL, token }
    },
    ...(targetSkills.length > 0 ? {
      skills: {
        contract_version: 2,
        entries: targetSkills.map((skill) => ({
          ref: skill.ref,
          skill_id: skill.skillId,
          name: skill.name,
          description: skill.description,
          file_count: skill.fileCount,
          total_bytes: skill.totalBytes,
          source: 'target_adapter'
        })),
        referenced_refs: referencedSkills.map((reference) => skillRefById.get(reference.id)!),
        load_endpoint: `/internal/v1/runs/${run.id}/skills/{skill_ref}`
      }
    } : {}),
    routing: { target_scoped: true },
    tracing: runtime.tracing
  });
}
