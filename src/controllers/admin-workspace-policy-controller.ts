import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { config } from '../config.js';
import { incrementAdminMutations } from '../metrics.js';
import { repo } from '../store/repository.js';
import { PolicyOperation } from '../store/repository-workspace-policy.js';
import { WorkspacePolicyError } from '../types/workspace-policy.js';
import { toSingleParam } from '../utils/params.js';
import { adminAuditEventInput, auditAdmin } from './admin-controller-common.js';

function policyFailure(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof WorkspacePolicyError) res.status(error.status).json({ error: { code: error.code, message: error.message, retryable: false } });
  else next(error);
}
export async function listWorkspacePlans(_req: AdminAuthenticatedRequest, res: Response): Promise<void> {
  res.status(200).json(config.WORKSPACE_PLANS);
}
export async function getWorkspacePolicy(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await repo.getWorkspacePolicy(toSingleParam(req.params.workspaceId))); }
  catch (error) { policyFailure(error, res, next); }
}
export function policyMutationHandler(operation: PolicyOperation) {
  return async (req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      incrementAdminMutations();
      const workspaceId = toSingleParam(req.params.workspaceId);
      if (req.body.requestId !== undefined && req.body.expectedPolicyVersion === undefined) throw new WorkspacePolicyError('POLICY_PRECONDITION_REQUIRED', 400, 'expectedPolicyVersion is required whenever requestId is supplied');
      const broad = req.admin.scopes.includes('admin:*') || req.admin.scopes.includes('admin:workspace:write');
      if (!broad && (!req.body.requestId || req.body.expectedPolicyVersion === undefined)) throw new WorkspacePolicyError('POLICY_PRECONDITION_REQUIRED', 400, 'requestId and expectedPolicyVersion are required');
      if (!broad && (operation === 'suspend' || operation === 'restore') && req.body.source !== 'external') throw new WorkspacePolicyError('FORBIDDEN', 403, 'External hold credentials must explicitly select source external');
      if (!broad && operation === 'restore' && !req.body.workspaceName) throw new WorkspacePolicyError('VALIDATION_ERROR', 400, 'Workspace name confirmation is required');
      if ((operation === 'plan' || operation === 'quotas') && req.body.source === 'external') throw new WorkspacePolicyError('FORBIDDEN', 403, 'External source cannot change plans or quotas');
      const action = operation === 'plan' || operation === 'quotas' ? `admin.workspace.${operation}.update` : `admin.workspace.${operation}`;
      const result = await repo.mutateWorkspacePolicy({ workspaceId, operation, body: req.body,
        audit: adminAuditEventInput(req, { action, workspaceId, reason: req.body.reason, metadata: { ticketRef: req.body.ticketRef ?? null } }) });
      res.status(200).json(result);
    } catch (error) {
      try {
        if (error instanceof WorkspacePolicyError && !error.auditRecorded) await auditAdmin(req, {
          action: operation === 'plan' || operation === 'quotas' ? `admin.workspace.${operation}.update` : `admin.workspace.${operation}`,
          outcome: 'failure', workspaceId: toSingleParam(req.params.workspaceId), reason: req.body.reason,
          metadata: { errorCode: error.code, operation, policyRequestId: req.body.requestId ?? null }
        });
        policyFailure(error, res, next);
      } catch (auditError) { next(auditError); }
    }
  };
}
export const patchWorkspacePlan = policyMutationHandler('plan');
export const patchWorkspaceQuotas = policyMutationHandler('quotas');
export const suspendWorkspace = policyMutationHandler('suspend');
export const restoreWorkspace = policyMutationHandler('restore');
