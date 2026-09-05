import type { Response } from 'express';

import type { AssistantReference } from '../types/assistant-references.js';
import type { TargetType, ToolAccessMode } from '../types/domain.js';
import type { RunPrincipalRef } from '../types/agents.js';
import { resolveReadyInteractiveRunTools } from './interactive-mcp-availability.js';

export async function requireTargetMcpConnectionsReady(
  res: Response,
  workspaceId: string,
  target: { targetId: string; targetType: TargetType },
  principal: RunPrincipalRef,
  toolAccessMode: ToolAccessMode,
  assistantReferences: AssistantReference[]
): Promise<boolean> {
  const availability = await resolveReadyInteractiveRunTools(res, {
    workspaceId,
    targetId: target.targetId,
    targetType: target.targetType,
    toolAccessMode,
    includeNativeTools: false,
    strictMcpResolution: true,
    principal,
    assistantReferences
  });
  return Boolean(availability);
}
