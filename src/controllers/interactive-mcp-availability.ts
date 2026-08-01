import type { Response } from 'express';
import {
  resolveInteractiveMcpToolAvailability,
  type InteractiveMcpToolAvailability
} from '../services/interactive-mcp-tool-availability.js';
import {
  resolveTargetRunTools,
  type TargetRunToolResolution
} from '../services/target-run-tool-resolution.js';
import { publicMcpReadinessError } from '../services/mcp-readiness.js';
import type { AssistantReference } from '../types/assistant-references.js';
import type { RunPrincipalRef } from '../types/agents.js';

async function resolveReadyInteractiveMcpTools(
  res: Response,
  input: {
    workspaceId: string;
    principal: RunPrincipalRef;
    resolution: TargetRunToolResolution;
    assistantReferences?: AssistantReference[];
  }
): Promise<InteractiveMcpToolAvailability | null> {
  const availability = await resolveInteractiveMcpToolAvailability(input);
  if (!availability.blockingReadiness) return availability;
  res.status(409).json({
    error: publicMcpReadinessError(availability.blockingReadiness)
  });
  return null;
}

export async function resolveReadyInteractiveRunTools(
  res: Response,
  input: Parameters<typeof resolveTargetRunTools>[0] & {
    principal: RunPrincipalRef;
    assistantReferences?: AssistantReference[];
  }
): Promise<InteractiveMcpToolAvailability | null> {
  const { principal, assistantReferences, ...resolutionInput } = input;
  return resolveReadyInteractiveMcpTools(res, {
    workspaceId: input.workspaceId,
    principal,
    resolution: await resolveTargetRunTools(resolutionInput),
    assistantReferences
  });
}
