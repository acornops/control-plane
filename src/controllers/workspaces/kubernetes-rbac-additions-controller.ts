import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireWorkspaceCapability } from '../../auth/workspace-authorization.js';
import {
  kubernetesRbacAdditionsHash,
  selectKubernetesRbacAdditions,
  type KubernetesRbacAddition
} from '../../services/kubernetes-rbac-additions.js';
import { getPlatformSetting } from '../../services/platform-settings.js';
import { toSingleParam } from '../../utils/params.js';

interface ResolvedKubernetesRbacAdditions {
  additions: KubernetesRbacAddition[];
  sourceVersion: number;
  contentHash: string;
}

/** Resolve current bundle keys into the immutable cluster-onboarding snapshot. */
export function resolveKubernetesRbacAdditionSelection(selectedKeys: unknown): ResolvedKubernetesRbacAdditions {
  const setting = getPlatformSetting('kubernetes_rbac_additions');
  const additions = selectKubernetesRbacAdditions(
    setting.value.additions,
    Array.isArray(selectedKeys) ? selectedKeys : []
  );
  return {
    additions,
    sourceVersion: setting.version,
    contentHash: kubernetesRbacAdditionsHash(additions)
  };
}

/** List user-facing bundle summaries without exposing administrator-authored rules. */
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
      'Only workspace roles with target management capability can view Kubernetes integrations'
    ))) return;
    const setting = getPlatformSetting('kubernetes_rbac_additions');
    res.status(200).json({
      version: setting.version,
      items: setting.value.additions.map(({ key, name, description }) => ({ key, name, description }))
    });
  } catch (error) {
    next(error);
  }
}
