import { LlmProvider } from '../../types/domain.js';
import { TargetInsightsToolConfig } from '../../types/target-insights.js';

export const TARGET_INSIGHTS_TOOL_ID = 'target_insights';

export const TARGET_INSIGHTS_DEFAULT_CONFIG: TargetInsightsToolConfig = {
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

export function normalizeTargetInsightsConfig(input?: Record<string, unknown> | null): TargetInsightsToolConfig {
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
        TARGET_INSIGHTS_DEFAULT_CONFIG.learning.idleCheckpointDelayMinutes,
        5,
        1440
      ),
      minimumObservationsBeforeGeneralization: boundedInt(
        learning.minimumObservationsBeforeGeneralization,
        TARGET_INSIGHTS_DEFAULT_CONFIG.learning.minimumObservationsBeforeGeneralization,
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
        TARGET_INSIGHTS_DEFAULT_CONFIG.retrieval.maxSnippetsPerRetrieval,
        1,
        8
      ),
      maxSnippetSizeBytes: boundedInt(
        retrieval.maxSnippetSizeBytes,
        TARGET_INSIGHTS_DEFAULT_CONFIG.retrieval.maxSnippetSizeBytes,
        512,
        4096
      )
    }
  };
}
