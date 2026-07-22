export const PROMPT_REFERENCE_ERROR_CODES = [
  'PROMPT_TOO_LONG',
  'PROMPT_REFERENCE_MALFORMED',
  'PROMPT_REFERENCE_LIMIT_EXCEEDED',
  'PROMPT_REFERENCE_UNKNOWN_TYPE',
  'PROMPT_REFERENCE_DUPLICATE',
  'PROMPT_REFERENCE_AMBIGUOUS',
  'PROMPT_REFERENCE_UNAVAILABLE',
  'PROMPT_REFERENCE_NOT_FOUND',
  'PROMPT_REFERENCE_DENIED',
  'PROMPT_REFERENCE_PLACEHOLDER',
  'PROMPT_REFERENCE_CARDINALITY',
  'PROMPT_REFERENCE_PROVIDER_TIMEOUT'
] as const;

export type PromptReferenceErrorCode = typeof PROMPT_REFERENCE_ERROR_CODES[number];
export type PromptReferenceState = 'placeholder' | 'concrete';
export type PromptResourceBindingSource = 'explicit' | 'implicit' | 'trigger';
export type PromptResourceContextMode = 'inline' | 'tool' | 'routing_only';

export interface PromptReferenceToken {
  type: string;
  label: string;
  start: number;
  end: number;
  state: PromptReferenceState;
}

export interface PromptReferenceParseError {
  code: 'PROMPT_TOO_LONG' | 'PROMPT_REFERENCE_MALFORMED' | 'PROMPT_REFERENCE_LIMIT_EXCEEDED';
  message: string;
  start?: number;
  end?: number;
}

export interface PromptReferenceParseResult {
  prompt: string;
  tokens: PromptReferenceToken[];
  errors: PromptReferenceParseError[];
}

export interface PromptReferenceTypeDescriptor {
  type: string;
  displayName: string;
  description: string;
  icon: string;
  placeholderLabel: string;
  availability: 'available' | 'unavailable';
  unavailableReason?: string;
  minimum: number;
  maximum: number;
  allowPinnedReferences: boolean;
  implicit?: boolean;
  provider: string;
  providerVersion: string;
}

export interface PromptResourceCandidate {
  type: string;
  id: string;
  label: string;
  description?: string;
  provider: string;
  availability: 'available' | 'unavailable';
  unavailableReason?: string;
  metadata?: Record<string, unknown>;
}

export interface PromptResourceBinding {
  bindingId: string;
  type: string;
  resourceId: string;
  provider: string;
  providerVersion: string;
  workspaceId: string;
  labelSnapshot: string;
  source: PromptResourceBindingSource;
  operations: string[];
  contextMode: PromptResourceContextMode;
  providerData?: Record<string, unknown>;
}

export interface PromptResourceRequirement {
  type: string;
  minimum: number;
  maximum: number;
  requiredOperations: string[];
  constraints?: Record<string, unknown>;
}

export interface PromptReferenceBlocker {
  code: PromptReferenceErrorCode;
  message: string;
  tokenIndex?: number;
  type?: string;
  retryable: boolean;
}

export interface PromptResolutionContext {
  workspaceId: string;
  actorUserId: string;
  workflowId?: string;
  workflowSessionId?: string;
  initiatingMessageId?: string;
  source?: PromptResourceBindingSource;
  mode: 'authoring' | 'launch';
  requirements?: PromptResourceRequirement[];
}

export interface PromptResourceAuthorization {
  operations: string[];
  contextMode: PromptResourceContextMode;
  providerData?: Record<string, unknown>;
}

export interface PromptResourceSuggestionContext {
  workspaceId: string;
  actorUserId: string;
  workflowId?: string;
  query: string;
  limit: number;
}

export interface PromptResourceProvider {
  descriptor(): PromptReferenceTypeDescriptor;
  suggest(context: PromptResourceSuggestionContext): Promise<PromptResourceCandidate[]>;
  resolve(token: PromptReferenceToken, context: PromptResolutionContext): Promise<PromptResourceCandidate>;
  authorize(
    candidate: PromptResourceCandidate,
    context: PromptResolutionContext
  ): Promise<PromptResourceAuthorization>;
  bind(
    candidate: PromptResourceCandidate,
    authorization: PromptResourceAuthorization,
    context: PromptResolutionContext
  ): Promise<Omit<PromptResourceBinding, 'bindingId'>>;
  loadContext?(
    binding: PromptResourceBinding,
    context: { runId: string; maximumBytes: number }
  ): Promise<Record<string, unknown>>;
  projectRuntime?(
    binding: PromptResourceBinding,
    context: { runId: string }
  ): Record<string, unknown>;
}

export interface PromptReferenceResolution {
  prompt: string;
  promptDigest: string;
  bindingDigest: string;
  tokens: PromptReferenceToken[];
  candidates: Array<PromptResourceCandidate | null>;
  bindings: PromptResourceBinding[];
  blockers: PromptReferenceBlocker[];
  resolvedAt: string;
}
