import type { Response } from 'express';
import {
  InvalidAssistantReferenceError,
  resolveTargetChatAssistantReferences,
  type AssistantReferenceRequest
} from '../services/target-chat-assistant-references.js';
import type { AssistantReference } from '../types/assistant-references.js';
import type { TargetType, ToolAccessMode } from '../types/domain.js';
import { requireTargetMcpConnectionsReady } from './session-mcp-readiness.js';

async function resolveSessionAssistantReferences(
  res: Response,
  params: {
    workspaceId: string;
    targetId: string;
    targetType: TargetType;
    toolAccessMode: ToolAccessMode;
    references: AssistantReferenceRequest[];
  }
): Promise<AssistantReference[] | null> {
  try {
    return await resolveTargetChatAssistantReferences(params);
  } catch (error) {
    if (!(error instanceof InvalidAssistantReferenceError)) throw error;
    res.status(409).json({
      error: {
        code: 'ASSISTANT_REFERENCE_INVALID',
        message: error.message,
        retryable: false,
        details: { references: error.references }
      }
    });
    return null;
  }
}

export async function resolveReadySessionAssistantReferences(
  res: Response,
  workspaceId: string,
  target: { targetId: string; targetType: TargetType },
  userId: string,
  toolAccessMode: ToolAccessMode,
  references: AssistantReferenceRequest[]
): Promise<AssistantReference[] | null> {
  if (!(await requireTargetMcpConnectionsReady(res, workspaceId, target, userId, toolAccessMode))) return null;
  return resolveSessionAssistantReferences(res, { workspaceId, ...target, toolAccessMode, references });
}
