import type { AuthenticatedRequest } from '../auth/middleware.js';
import type { WorkflowExecutionRecord } from '../store/repository-workflows.js';

export function externalIntegrationOwnsWorkflowExecution(
  req: AuthenticatedRequest,
  execution: WorkflowExecutionRecord
): boolean {
  const credential = req.auth.credential;
  return credential.type === 'external_integration'
    && execution.requestProvenance.actorType === 'external_integration'
    && execution.requestProvenance.externalIntegrationLinkId === credential.linkId
    && execution.requestProvenance.externalIntegrationClientId === credential.integrationId;
}
