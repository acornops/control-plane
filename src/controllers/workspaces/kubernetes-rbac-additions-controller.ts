import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireWorkspaceCapability } from '../../auth/workspace-authorization.js';
import { toSingleParam } from '../../utils/params.js';

export async function listKubernetesRbacAdditions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_targets',
      'Only workspace roles with target management capability can view cluster onboarding options'
    ))) return;
    // Keep the optional console surface truthful until governed additions are
    // implemented across the control plane, installation snapshot, and AgentK.
    res.status(200).json({ version: 1, items: [] });
  } catch (err) {
    next(err);
  }
}
