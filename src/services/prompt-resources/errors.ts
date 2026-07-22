import type { PromptReferenceErrorCode } from '../../types/prompt-resources.js';

export class PromptResourceProviderError extends Error {
  constructor(
    readonly code: PromptReferenceErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'PromptResourceProviderError';
  }
}

export function boundedProviderMessage(message: string): string {
  const normalized = message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 300) || 'The prompt resource provider could not resolve this reference.';
}
