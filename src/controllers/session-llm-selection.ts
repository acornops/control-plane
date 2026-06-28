import { Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  isSupportedLlmProvider,
  parseAllowedReasoningEfforts
} from '../services/llm-policy.js';
import { LlmProvider, ReasoningEffort } from '../types/domain.js';

export interface RequestedLlmSelection {
  provider?: LlmProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

function rejectInvalidLlmSelection(res: Response, message: string): void {
  res.status(400).json({
    error: {
      code: 'INVALID_LLM_SELECTION',
      message,
      retryable: false
    }
  });
}

export function parseRequestedLlmSelection(req: AuthenticatedRequest, res: Response): RequestedLlmSelection | null {
  const raw = req.body.llm;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    rejectInvalidLlmSelection(res, 'llm must be an object when provided');
    return null;
  }

  const input = raw as Record<string, unknown>;
  const selection: RequestedLlmSelection = {};
  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string' || !isSupportedLlmProvider(input.provider)) {
      res.status(400).json({
        error: {
          code: 'PROVIDER_NOT_ALLOWED',
          message: 'Selected provider is not supported',
          retryable: false
        }
      });
      return null;
    }
    selection.provider = input.provider;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !input.model.trim()) {
      rejectInvalidLlmSelection(res, 'llm.model must be a non-empty string');
      return null;
    }
    if (!selection.provider) {
      rejectInvalidLlmSelection(res, 'llm.provider is required when llm.model is provided');
      return null;
    }
    selection.model = input.model.trim();
  }
  if (selection.provider && !selection.model) {
    rejectInvalidLlmSelection(res, 'llm.model is required when llm.provider is provided');
    return null;
  }
  if (input.reasoningEffort !== undefined) {
    if (typeof input.reasoningEffort !== 'string' || !parseAllowedReasoningEfforts().includes(input.reasoningEffort as ReasoningEffort)) {
      res.status(400).json({
        error: {
          code: 'REASONING_EFFORT_NOT_ALLOWED',
          message: 'Selected reasoning effort is not allowed by this deployment',
          retryable: false
        }
      });
      return null;
    }
    selection.reasoningEffort = input.reasoningEffort as ReasoningEffort;
  }
  return selection;
}
