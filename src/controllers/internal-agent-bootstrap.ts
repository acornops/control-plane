import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { config } from '../config.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { gatewayTokenService } from '../services/token-service.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import type { AgentActivityRecord } from '../types/agents.js';

export async function bootstrapAgentRun(run: AgentActivityRecord, res: Response): Promise<void> {
  const llmSettings = await resolveWorkspaceLlmSettings(run.workspaceId);
  if (!llmSettings.credentialConfigured) {
    res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Workspace AI provider credential is not configured', retryable: false } });
    return;
  }
  const snapshotInstallations = run.agentSnapshot?.mcpInstallations || [];
  const grantedRefs = new Set(run.compiledScope.mcpTools.map((ref) => `${ref.serverId}\u0000${ref.toolName}`));
  const snapshotMcpTools = snapshotInstallations.flatMap((installation) => {
    const constraints = installation.targetConstraints;
    const targetAllowed = (!constraints.targetIds.length || Boolean(run.targetId && constraints.targetIds.includes(run.targetId)))
      && (!constraints.targetTypes.length || Boolean(run.targetType && constraints.targetTypes.some((type) => type === run.targetType)));
    if (!installation.enabled || !targetAllowed) return [];
    return installation.tools.filter((tool) => tool.enabled
      && tool.reviewState === 'approved'
      && grantedRefs.has(`${tool.serverId}\u0000${tool.toolName}`));
  });
  let allowedTools: string[] = [];
  let allowedToolOperations: Record<string, 'read' | 'write'> = {};
  let allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }> = [];
  let allowedToolRefs: Array<{ serverId: string; toolName: string }> = snapshotMcpTools.map((tool) => ({
    serverId: tool.serverId,
    toolName: tool.toolName
  }));
  let toolSpecs: Array<{ name: string; server_id?: string; tool_name?: string; description: string; capability: 'read'|'write'; input_schema: Record<string, unknown> }> = [];
  if (run.targetId && run.targetType) {
    const compiledAllowsWrite = Object.values(run.compiledScope.toolOperations).includes('write');
    const targetTools = await resolveTargetRunTools({
      workspaceId: run.workspaceId, targetId: run.targetId, targetType: run.targetType,
      toolAccessMode: compiledAllowsWrite ? 'read_write' : 'read_only', runId: run.id, includeNativeTools: false
    });
    const granted = new Set(run.compiledScope.tools);
    const grantedTargetRefs = new Set((run.compiledScope.targetToolRefs || [])
      .map((ref) => `${ref.serverId}\0${ref.toolName}`));
    toolSpecs = targetTools.allowedToolSpecs.filter((spec) => granted.has(spec.name)
      && Boolean(spec.server_id && spec.tool_name
        && grantedTargetRefs.has(`${spec.server_id}\0${spec.tool_name}`)));
    allowedTools = toolSpecs.map((spec) => spec.name);
    allowedToolOperations = Object.fromEntries(allowedTools.map((name) => [
      name,
      run.compiledScope.toolOperations[name] === 'write' ? 'write' as const : 'read' as const
    ]));
    allowedNativeTools = [];
    const nativeRefs = targetTools.allowedToolRefs.filter((ref) =>
      toolSpecs.some((spec) => spec.server_id === ref.serverId && spec.tool_name === ref.toolName)
    );
    allowedToolRefs = [...nativeRefs, ...allowedToolRefs];
  }
  for (const tool of snapshotMcpTools) {
    allowedTools.push(tool.alias);
    allowedToolOperations[tool.alias] = tool.capability === 'write' ? 'write' : 'read';
    toolSpecs.push({
      name: tool.alias,
      server_id: tool.serverId,
      tool_name: tool.toolName,
      description: tool.description || `Execute reviewed MCP tool "${tool.toolName}".`,
      capability: tool.capability,
      input_schema: tool.inputSchema || { type: 'object' }
    });
  }
  allowedTools = [...new Set(allowedTools)];
  const token = await gatewayTokenService.signRunScopeToken({
    scopeType: 'workspace', runId: run.id, workspaceId: run.workspaceId, sessionId: run.id,
    ...(run.compiledScope.principal.type === 'user' ? { userId: run.compiledScope.principal.id } : {}),
    principal: run.compiledScope.principal,
    permissionMode: run.compiledScope.permissionMode,
    agentId: run.agentId, agentVersion: run.agentVersion, triggerId: run.triggerId,
    targetId: run.targetId, targetType: run.targetType,
    allowedProviders: llmSettings.allowedProviders, allowedTools, allowedToolRefs, allowedNativeTools,
    allowedToolOperations, contextGrants: run.compiledScope.contextGrants,
    maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS, allowedModels: llmSettings.allowedModels
  });
  const agentApprovalPolicy = run.agentSnapshot?.approvalPolicy;
  const confirmationRequiredForWrite = Object.values(allowedToolOperations).includes('write') && (
    run.compiledScope.permissionMode === 'ask_before_changes'
    || run.compiledScope.permissionMode === 'read_only'
    || agentApprovalPolicy?.mode === 'always'
    || agentApprovalPolicy?.mode === 'before_write'
    || agentApprovalPolicy?.writeToolsRequireApproval !== false
  );
  const agentSkills = (run.agentSnapshot?.skillInstallations || [])
    .filter((skill) => skill.enabled && run.compiledScope.enabledSkills.includes(skill.id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  res.status(200).json({
    contract_version: 2,
    scope: { type: 'workspace', workspace_id: run.workspaceId, session_id: run.id, run_id: run.id,
      agent_id: run.agentId, agent_version: run.agentVersion, trigger_id: run.triggerId,
      target_id: run.targetId, target_type: run.targetType },
    agent: { id: run.agentId, version: run.agentVersion },
    assistant: {
      instructions: run.agentSnapshot?.instructions || ''
    },
    policy: { max_runtime_ms: config.ASSISTANT_MAX_RUNTIME_MS, max_output_tokens: config.LLM_MAX_OUTPUT_TOKENS ?? null,
      budget_cents: config.ASSISTANT_BUDGET_CENTS, max_steps: config.ASSISTANT_MAX_STEPS,
      max_tool_calls: config.ASSISTANT_MAX_TOOL_CALLS, max_duplicate_tool_calls: config.ASSISTANT_MAX_DUPLICATE_TOOL_CALLS },
    context: { endpoint: `/internal/v1/agent-runs/${run.id}/context`, max_context_tokens: config.ASSISTANT_CONTEXT_MAX_TOKENS },
    llm: { provider: llmSettings.provider, model: llmSettings.model, temperature: config.ASSISTANT_LLM_TEMPERATURE,
      mode: 'gateway', reasoning: llmSettings.reasoning,
      gateway: { url: config.LLM_GATEWAY_URL, token, request_timeout_ms: config.LLM_GATEWAY_TIMEOUT_MS } },
    tools: { tool_registry_version: 'trv_1', allowed_tools: allowedTools,
      allowed_tool_refs: allowedToolRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })), native_tools: allowedNativeTools,
      platform_functions: [],
      tool_specs: toolSpecs, write_unavailable_reason: null,
      confirmation_required_for_write: confirmationRequiredForWrite,
      approval_timeout_seconds: config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
      gateway: { url: config.LLM_GATEWAY_URL, token } },
    ...(agentSkills.length ? { skills: {
      contract_version: 2,
      entries: agentSkills.map((skill, index) => ({
        ref: `skill_${index + 1}`,
        skill_id: skill.id,
        name: skill.name,
        description: skill.description,
        file_count: skill.files.length,
        total_bytes: skill.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0)
      })),
      load_endpoint: `/internal/v1/agent-runs/${run.id}/skills/{skill_ref}`
    } } : {}),
    routing: { target_scoped: Boolean(run.targetId), workflow_scoped: false },
    tracing: { trace_id: randomUUID(), sample_rate: 0.1 }
  });
}
