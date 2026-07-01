import { LlmProvider, TargetType } from './domain.js';

export type KnowledgeBankEntryStatus = 'active' | 'pending' | 'archived';
export type KnowledgeBankCheckpointModelMode = 'workspace_default' | 'custom';
export type KnowledgeBankCheckpointStatus = 'applied' | 'skipped' | 'failed' | 'noop';

export interface KnowledgeBankCheckpointModelConfig {
  mode: KnowledgeBankCheckpointModelMode;
  provider?: LlmProvider;
  model?: string;
}

export interface KnowledgeBankToolConfig {
  learning: {
    idleCheckpointDelayMinutes: number;
    minimumObservationsBeforeGeneralization: number;
    checkpointModel: KnowledgeBankCheckpointModelConfig;
  };
  retrieval: {
    maxSnippetsPerRetrieval: number;
    maxSnippetSizeBytes: number;
  };
}

export interface KnowledgeBankEntry {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  title: string;
  status: KnowledgeBankEntryStatus;
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

export interface KnowledgeBankEntryInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  title: string;
  status: KnowledgeBankEntryStatus;
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

export interface KnowledgeBankEntryPatch {
  title?: string;
  status?: KnowledgeBankEntryStatus;
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

export interface KnowledgeBankRetrievalQuery {
  workspaceId: string;
  targetId: string;
  text: string;
  config: KnowledgeBankToolConfig;
}

export interface KnowledgeBankSnippet {
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
