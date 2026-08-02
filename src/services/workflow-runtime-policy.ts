import { config } from '../config.js';

export interface EffectiveWorkflowRuntimePolicy {
  maxRuntimeSeconds: number;
  retentionDays: number;
}

export function effectiveWorkflowRuntimePolicy(): EffectiveWorkflowRuntimePolicy {
  return {
    maxRuntimeSeconds: Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000)),
    retentionDays: config.GENERATED_DOCUMENT_RETENTION_DAYS
  };
}
