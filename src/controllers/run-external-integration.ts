import type { AuthenticatedRequest } from '../auth/middleware.js';
import { repo } from '../store/repository.js';
import { publicRunApproval } from './external-run-public.js';

export function isExternalIntegrationRequest(req: AuthenticatedRequest): boolean {
  return req.auth.credential.type === 'external_integration';
}

export function approvalForRequest<T>(req: AuthenticatedRequest, approval: T): T | Record<string, unknown> {
  return isExternalIntegrationRequest(req)
    ? publicRunApproval(approval as Parameters<typeof publicRunApproval>[0])
    : approval;
}

export function approvalsForRequest<T>(req: AuthenticatedRequest, approvals: T[]): T[] | Record<string, unknown>[] {
  return isExternalIntegrationRequest(req)
    ? approvals.map((approval) => publicRunApproval(approval as Parameters<typeof publicRunApproval>[0]))
    : approvals;
}

export async function externalIntegrationOwnsTroubleshootingRun(
  req: AuthenticatedRequest,
  runId: string
): Promise<boolean> {
  const credential = req.auth.credential;
  if (credential.type !== 'external_integration') return false;
  const provenance = await repo.getRunRequestProvenance(runId);
  return provenance?.actorType === 'external_integration'
    && provenance.externalIntegrationLinkId === credential.linkId
    && provenance.externalIntegrationClientId === credential.integrationId;
}
