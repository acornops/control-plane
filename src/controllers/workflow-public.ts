import type {
  CompiledWorkflowAccessScope,
  PublicWorkflowDefinition,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import { withEffectiveWorkflowRuntimePolicy } from '../services/workflow-runtime-policy.js';

export function publicWorkflowDefinition(
  workflow: WorkflowDefinitionForAccess
): PublicWorkflowDefinition {
  const { entryAgentId: _entryAgentId, delegationPolicy: _delegationPolicy, ...publicWorkflow } = workflow;
  return {
    ...publicWorkflow,
    capabilityPolicy: withEffectiveWorkflowRuntimePolicy(publicWorkflow.capabilityPolicy)
  };
}

export function publicCompiledWorkflowScope(
  scope: CompiledWorkflowAccessScope
): Omit<CompiledWorkflowAccessScope, 'entryAgent' | 'jwtClaims'> & {
  executionMode: WorkflowDefinitionForAccess['executionMode'];
} {
  const { entryAgent: _entryAgent, jwtClaims: _jwtClaims, ...publicScope } = scope;
  return {
    ...publicScope,
    executionMode: scope.coordinationFunctions.length > 0 ? 'coordinated' : 'direct'
  };
}
