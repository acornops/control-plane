import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { WorkspaceLlmSettingsResolution } from '../services/workspace-ai-resolution.js';
import type { Run } from '../types/domain.js';

export function interactiveRunBootstrapContract(
  run: Pick<Run, 'sessionId'>,
  llm: WorkspaceLlmSettingsResolution,
  token: string
) {
  return {
    policy: {
      max_runtime_ms: config.ASSISTANT_MAX_RUNTIME_MS,
      max_output_tokens: config.LLM_MAX_OUTPUT_TOKENS ?? null,
      budget_cents: config.ASSISTANT_BUDGET_CENTS,
      max_steps: config.ASSISTANT_MAX_STEPS,
      max_tool_calls: config.ASSISTANT_MAX_TOOL_CALLS,
      max_duplicate_tool_calls: config.ASSISTANT_MAX_DUPLICATE_TOOL_CALLS
    },
    context: {
      endpoint: `/internal/v1/sessions/${run.sessionId}/context`,
      max_context_tokens: config.ASSISTANT_CONTEXT_MAX_TOKENS
    },
    llm: {
      provider: llm.provider,
      model: llm.model,
      temperature: config.ASSISTANT_LLM_TEMPERATURE,
      mode: 'gateway' as const,
      reasoning: llm.reasoning,
      gateway: {
        url: config.LLM_GATEWAY_URL,
        token,
        request_timeout_ms: config.LLM_GATEWAY_TIMEOUT_MS
      }
    },
    tracing: { trace_id: randomUUID(), sample_rate: 0.1 }
  };
}
