import type { Response } from 'express';
import type { WorkflowAccessDeniedError } from '../services/workflow-access.js';
import type {
  PublicWorkflowDefinition,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';

export function respondWorkflowAccessError(res: Response, error: WorkflowAccessDeniedError): void {
  res.status(error.code === 'WORKFLOW_PERMISSION_DENIED' ? 403 : 409).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
      details: {
        missingPermissions: error.missingPermissions
      }
    }
  });
}

export function publicWorkflowDefinition(
  workflow: WorkflowDefinitionForAccess
): PublicWorkflowDefinition {
  return { ...workflow };
}
