import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { loadAutomationDiagnostics } from '../services/automation-diagnostics.js';
import { toSingleParam } from '../utils/params.js';

export async function getAutomationDiagnostics(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to automation diagnostics'))) return;
    res.status(200).json(await loadAutomationDiagnostics(workspaceId));
  } catch (err) {
    next(err);
  }
}
