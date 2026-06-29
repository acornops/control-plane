import { LlmProvider } from '../../types/domain.js';
import { KnowledgeBankToolConfig } from '../../types/knowledge-bank.js';

export const KNOWLEDGE_BANK_TOOL_ID = 'knowledge_bank';

export const KNOWLEDGE_BANK_DEFAULT_CONFIG: KnowledgeBankToolConfig = {
  learning: {
    idleCheckpointDelayMinutes: 30,
    minimumObservationsBeforeGeneralization: 3,
    checkpointModel: {
      mode: 'workspace_default'
    }
  },
  retrieval: {
    maxSnippetsPerRetrieval: 4,
    maxSnippetSizeBytes: 1536
  }
};

const LLM_PROVIDERS = new Set<LlmProvider>(['openai', 'anthropic', 'gemini']);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function optionalProvider(value: unknown): LlmProvider | undefined {
  return typeof value === 'string' && LLM_PROVIDERS.has(value as LlmProvider) ? value as LlmProvider : undefined;
}

export function normalizeKnowledgeBankConfig(input?: Record<string, unknown> | null): KnowledgeBankToolConfig {
  const config = asObject(input);
  const learning = asObject(config.learning);
  const retrieval = asObject(config.retrieval);
  const checkpointModel = asObject(learning.checkpointModel);
  const mode = checkpointModel.mode === 'custom' ? 'custom' : 'workspace_default';
  const provider = optionalProvider(checkpointModel.provider);
  const model = typeof checkpointModel.model === 'string' ? checkpointModel.model.trim() : '';

  return {
    learning: {
      idleCheckpointDelayMinutes: boundedInt(
        learning.idleCheckpointDelayMinutes,
        KNOWLEDGE_BANK_DEFAULT_CONFIG.learning.idleCheckpointDelayMinutes,
        5,
        1440
      ),
      minimumObservationsBeforeGeneralization: boundedInt(
        learning.minimumObservationsBeforeGeneralization,
        KNOWLEDGE_BANK_DEFAULT_CONFIG.learning.minimumObservationsBeforeGeneralization,
        2,
        10
      ),
      checkpointModel: mode === 'custom' && provider && model
        ? { mode, provider, model }
        : { mode: 'workspace_default' }
    },
    retrieval: {
      maxSnippetsPerRetrieval: boundedInt(
        retrieval.maxSnippetsPerRetrieval,
        KNOWLEDGE_BANK_DEFAULT_CONFIG.retrieval.maxSnippetsPerRetrieval,
        1,
        8
      ),
      maxSnippetSizeBytes: boundedInt(
        retrieval.maxSnippetSizeBytes,
        KNOWLEDGE_BANK_DEFAULT_CONFIG.retrieval.maxSnippetSizeBytes,
        512,
        4096
      )
    }
  };
}
