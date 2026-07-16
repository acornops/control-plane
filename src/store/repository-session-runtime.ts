import { ChatSession, LlmProvider, ReasoningEffort } from '../types/domain.js';

export interface SessionRuntimeSelectionRow {
  last_llm_provider?: LlmProvider | null;
  last_llm_model?: string | null;
  last_llm_reasoning_effort?: ReasoningEffort | null;
}

export function mapLastRuntimeSelection(
  row: SessionRuntimeSelectionRow
): ChatSession['lastRuntimeSelection'] {
  if (!row.last_llm_provider || !row.last_llm_model || !row.last_llm_reasoning_effort) return undefined;
  return {
    provider: row.last_llm_provider,
    model: row.last_llm_model,
    reasoningEffort: row.last_llm_reasoning_effort
  };
}
