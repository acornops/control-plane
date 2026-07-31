import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import {
  GitSkillImportError,
  resolveGitSkill
} from '../../services/git-skill-import.js';
import { toSingleParam } from '../../utils/params.js';
import { respondMissingSkillCapability } from './target-skill-helpers.js';

export function respondGitSkillImportError(res: Response, error: GitSkillImportError): void {
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.status === 429 || error.status === 503
    }
  });
}

export async function resolveTargetGitSkill(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    if (!access.authz.can('manage_skills')) {
      respondMissingSkillCapability(res);
      return;
    }
    res.status(200).json(await resolveGitSkill(req.body));
  } catch (error) {
    if (error instanceof GitSkillImportError) {
      respondGitSkillImportError(res, error);
      return;
    }
    next(error);
  }
}
