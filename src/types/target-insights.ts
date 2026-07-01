import { LlmProvider, TargetType } from './domain.js';

export type TargetInsightsEntryStatus = 'active' | 'pending' | 'archived';
export type TargetInsightsCheckpointModelMode = 'workspace_default' | 'custom';
export type TargetInsightsCheckpointStatus = 'applied' | 'skipped' | 'failed' | 'noop';

export interface TargetInsightsCheckpointModelConfig {
  mode: TargetInsightsCheckpointModelMode;
  provider?: LlmProvider;
  model?: string;
}

export interface TargetInsightsToolConfig {
  learning: {
    idleCheckpointDelayMinutes: number;
    minimumObservationsBeforeGeneralization: number;
    checkpointModel: TargetInsightsCheckpointModelConfig;
  };
  retrieval: {
    maxSnippetsPerRetrieval: number;
    maxSnippetSizeBytes: number;
  };
}

export interface TargetInsightsEntry {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  title: string;
  status: TargetInsightsEntryStatus;
  bodyMarkdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  signals: Record<string, unknown>;
  scope: Record<string, unknown>;
  evidenceSummary: string;
  observationCount: number;
  confidence: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TargetInsightsEntryInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  title: string;
  status: TargetInsightsEntryStatus;
  bodyMarkdown: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  signals?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  evidenceSummary?: string;
  observationCount?: number;
  confidence?: number;
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
}

export interface TargetInsightsEntryPatch {
  title?: string;
  status?: TargetInsightsEntryStatus;
  bodyMarkdown?: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  signals?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  evidenceSummary?: string;
  observationCount?: number;
  confidence?: number;
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
}

export interface TargetInsightsRetrievalQuery {
  workspaceId: string;
  targetId: string;
  text: string;
  config: TargetInsightsToolConfig;
}

export interface TargetInsightsSnippet {
  entryId: string;
  title: string;
  body: string;
  evidenceSummary: string;
  tags: string[];
  confidence: number;
  observationCount: number;
  score: number;
  updatedAt: string;
}
