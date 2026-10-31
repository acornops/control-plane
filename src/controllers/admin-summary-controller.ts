import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { getAdminUserOverview, getAdminWorkspaceOverview } from '../store/repository-admin-summary.js';

export async function workspaceSummary(_req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await getAdminWorkspaceOverview()); }
  catch (error) { next(error); }
}

export async function userSummary(_req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await getAdminUserOverview()); }
  catch (error) { next(error); }
}
