import { AuthenticatedRequest } from '../auth/middleware.js';
import { RunRequestProvenance } from '../store/repository-run-provenance.js';

export function runRequestProvenance(req: AuthenticatedRequest): RunRequestProvenance {
  const credential = req.auth.credential;
  return credential.type === 'external_integration'
    ? {
        actorType: 'external_integration',
        externalIntegrationLinkId: credential.linkId,
        externalIntegrationClientId: credential.integrationId
      }
    : { actorType: 'user' };
}

export function runAuditActor(req: AuthenticatedRequest): {
  actorUserId: string;
  actorType?: 'external_integration';
  actorTokenId?: string;
} {
  const credential = req.auth.credential;
  return credential.type === 'external_integration'
    ? {
        actorUserId: req.auth.userId,
        actorType: 'external_integration',
        actorTokenId: credential.integrationId
      }
    : { actorUserId: req.auth.userId };
}
