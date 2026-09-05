import type { Response } from 'express';
import {
  resolveInteractiveMcpToolAvailability,
  type InteractiveMcpToolAvailability
} from '../services/interactive-mcp-tool-availability.js';
import {
  resolveTargetRunTools,
  type TargetRunToolResolution
} from '../services/target-run-tool-resolution.js';
import { isMcpLifecycleFencedError } from '../services/mcp-registry-client.js';
import { publicMcpReadinessError } from '../services/mcp-readiness.js';
import type { AssistantReference } from '../types/assistant-references.js';
import type { RunPrincipalRef } from '../types/agents.js';
import { mapGatewayError } from './workspaces/common.js';

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
  let resolution: TargetRunToolResolution;
  try {
    resolution = await resolveTargetRunTools(resolutionInput);
  } catch (error) {
    if (!isMcpLifecycleFencedError(error)) throw error;
    const mapped = mapGatewayError(error);
    res.status(mapped.status).json(mapped.body);
    return null;
  }
  return resolveReadyInteractiveMcpTools(res, {
    workspaceId: input.workspaceId,
    principal,
    resolution,
    assistantReferences
  });
}
