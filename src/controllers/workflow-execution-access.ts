import type { AuthenticatedRequest } from '../auth/middleware.js';
import type { WorkflowExecutionRecord, WorkflowSessionRecord } from '../store/repository-workflows.js';

function externalIntegrationOwnsProvenance(
  req: AuthenticatedRequest,
  provenance: WorkflowExecutionRecord['requestProvenance']
): boolean {
  const credential = req.auth.credential;
  return credential.type === 'external_integration'
    && provenance.actorType === 'external_integration'
    && provenance.externalIntegrationLinkId === credential.linkId
    && provenance.externalIntegrationClientId === credential.integrationId;
}

export function externalIntegrationOwnsWorkflowExecution(
  req: AuthenticatedRequest,
  execution: WorkflowExecutionRecord
): boolean {
  return externalIntegrationOwnsProvenance(req, execution.requestProvenance);
}

export function externalIntegrationOwnsWorkflowSession(
  req: AuthenticatedRequest,
  session: WorkflowSessionRecord
): boolean {
  return externalIntegrationOwnsProvenance(req, session.requestProvenance);
}
