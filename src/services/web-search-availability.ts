import { config } from '../config.js';
import type { LlmProvider } from '../types/domain.js';

export const OPENAI_RESPONSES_API_REQUIRED = 'openai_responses_api_required' as const;

export interface WebSearchAvailability {
  available: boolean;
  unavailableReason: typeof OPENAI_RESPONSES_API_REQUIRED | null;
}

export function webSearchAvailability(provider: LlmProvider): WebSearchAvailability {
  const unavailable =
    provider === 'openai'
    && config.LLM_PROVIDER_OPENAI_API_SURFACE === 'chat_completions';

  return {
    available: !unavailable,
    unavailableReason: unavailable ? OPENAI_RESPONSES_API_REQUIRED : null
  };
}
