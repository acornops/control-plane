import type { Response } from 'express';
import { config } from '../config.js';
import { resolveAgentChatRunTools } from '../services/agent-chat-run-tools.js';
import { resolveRunSkillSnapshots } from '../services/run-skill-snapshots.js';
import { gatewayTokenService } from '../services/token-service.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { repo } from '../store/repository.js';
import type { ChatSession, Run } from '../types/domain.js';
import { rejectUnavailableInteractiveLlm } from './interactive-llm-validation.js';
import { interactiveRunBootstrapContract } from './interactive-run-bootstrap-contract.js';

export function agentChatRunSnapshotIsValid(run: Run, session: ChatSession): boolean {
  const scope = run.compiledAccessScope;
  const agent = run.agentSnapshot;
  const principal = run.principal;
  const expectedRunCapability = run.toolAccessMode === 'read_write'
    ? 'create_read_write_runs'
    : 'create_read_only_runs';
  return run.conversationKind === 'agent_chat'
    && session.conversationKind === 'agent_chat'
    && session.workspaceId === run.workspaceId
    && session.agentId === run.agentId
    && Boolean(agent && run.agentId && scope)
    && agent?.id === run.agentId
    && agent?.workspaceId === run.workspaceId
    && scope?.workspaceId === run.workspaceId
    && scope?.agentId === run.agentId
    && scope?.mode === run.toolAccessMode
    && scope?.resourceResolutionPhase === 'run_exact'
    && scope?.requiredPermissions.length === 1
    && scope.requiredPermissions[0] === expectedRunCapability
    && scope?.grantedCapabilities.length === 1
    && scope.grantedCapabilities[0] === expectedRunCapability
    && principal?.type === 'user'
    && principal.id === session.createdBy
    && scope?.actor.userId === principal.id
    && scope?.principal.type === principal.type
    && scope?.principal.id === principal.id;
}

export async function bootstrapAgentChatRun(run: Run, res: Response): Promise<void> {
  const session = await repo.getSession(run.sessionId);
  if (!session || !agentChatRunSnapshotIsValid(run, session)) {
    res.status(409).json({ error: {
      code: 'AGENT_CHAT_SNAPSHOT_INVALID',
      message: 'Agent chat run is missing its pinned execution snapshot.',
      retryable: false
    } });
    return;
  }
  const llmSettings = await resolveWorkspaceLlmSettings(run.workspaceId, {
    provider: run.llmProvider,
    model: run.llmModel,
    reasoningSummaryMode: run.llmReasoningSummaryMode,
    reasoningEffort: run.llmReasoningEffort
  });
  if (rejectUnavailableInteractiveLlm(res, llmSettings)) return;

  const tools = await resolveAgentChatRunTools(run);
  const scope = run.compiledAccessScope!;
  const agentSnapshot = run.agentSnapshot!;
  const skills = resolveRunSkillSnapshots(agentSnapshot, scope.enabledSkills);
  const agentId = run.agentId!;
  const principal = run.principal!;
  const token = await gatewayTokenService.signRunScopeToken({
    runId: run.id,
    scopeType: 'agent_chat',
    workspaceId: run.workspaceId,
    sessionId: run.sessionId,
    ...(principal.type === 'user' ? { userId: principal.id } : {}),
    principal,
    permissionMode: scope.permissionMode,
    allowedProviders: llmSettings.allowedProviders,
    allowedModels: llmSettings.allowedModels,
    allowedTools: tools.allowedToolNames,
    allowedToolRefs: tools.allowedToolRefs,
    allowedNativeTools: tools.allowedNativeTools,
    allowedToolOperations: tools.allowedToolOperations,
    contextGrants: scope.contextGrants,
    resourceBindings: scope.resourceBindings,
    bindingDigest: scope.bindingDigest,
    maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
    agentId
  });
  const runtime = interactiveRunBootstrapContract(run, llmSettings, token);
  res.status(200).json({
    contract_version: 2,
    scope: {
      type: 'agent_chat',
      workspace_id: run.workspaceId,
      session_id: run.sessionId,
      run_id: run.id,
      user_id: session.createdBy,
      agent_id: agentId
    },
    assistant: { instructions: agentSnapshot.instructions },
    policy: runtime.policy,
    context: runtime.context,
    ...(scope.promptDigest && scope.bindingDigest ? {
      resources: {
        prompt_digest: scope.promptDigest,
        binding_digest: scope.bindingDigest,
        resolved_at: run.requestedAt,
        bindings: scope.resourceBindings.map((binding) => ({
          binding_id: binding.bindingId,
          type: binding.type,
          resource_id: binding.resourceId,
          provider: binding.provider,
          provider_version: binding.providerVersion,
          workspace_id: binding.workspaceId,
          label_snapshot: binding.labelSnapshot,
          source: binding.source,
          operations: binding.operations,
          context_mode: binding.contextMode,
          ...(binding.providerData ? { provider_data: binding.providerData } : {})
        }))
      }
    } : {}),
    llm: runtime.llm,
    tools: {
      tool_registry_version: 'trv_1',
      allowed_tools: tools.allowedToolNames,
      allowed_tool_refs: tools.allowedToolRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
      native_tools: tools.allowedNativeTools,
      platform_functions: tools.platformFunctions,
      tool_specs: tools.allowedToolSpecs,
      write_unavailable_reason: null,
      confirmation_required_for_write: Object.values(tools.allowedToolOperations).includes('write'),
      approval_timeout_seconds: config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
      gateway: { url: config.LLM_GATEWAY_URL, token }
    },
    ...(skills.length > 0 ? {
      skills: {
        contract_version: 2,
        entries: skills.map(({ ref, installation, totalBytes }) => ({
          ref,
          skill_id: installation.id,
          name: installation.name,
          description: installation.description,
          file_count: installation.files.length,
          total_bytes: totalBytes,
          source: 'agent'
        })),
        referenced_refs: [],
        load_endpoint: `/internal/v1/runs/${run.id}/skills/{skill_ref}`
      }
    } : {}),
    routing: { agent_scoped: true },
    tracing: runtime.tracing
  });
}
