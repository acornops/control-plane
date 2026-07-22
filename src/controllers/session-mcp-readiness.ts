import type { Response } from 'express';

import {
  getTargetMcpConnectionReadinessReport,
  publicMcpReadinessError
} from '../services/workflow-readiness.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import type { TargetType, ToolAccessMode } from '../types/domain.js';

export async function requireTargetMcpConnectionsReady(
  res: Response,
  workspaceId: string,
  target: { targetId: string; targetType: TargetType },
  userId: string,
  toolAccessMode: ToolAccessMode
): Promise<boolean> {
  const resolution = await resolveTargetRunTools({
    workspaceId,
    targetId: target.targetId,
    targetType: target.targetType,
    toolAccessMode,
    includeNativeTools: false,
    strictMcpResolution: true
  });
  const readiness = await getTargetMcpConnectionReadinessReport(
    workspaceId,
    userId,
    resolution.allowedToolRefs
  );
  if (readiness.errors.length === 0) return true;
  res.status(409).json({
    error: publicMcpReadinessError(readiness)
  });
  return false;
}
