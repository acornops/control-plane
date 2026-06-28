import type { WorkflowRunRecord } from '../store/repository-workflows.js';

export interface WorkflowRunAgentClaims {
  agentId?: string;
  agentVersion?: number;
  triggerId?: string;
}

export function workflowRunAgentClaims(run: WorkflowRunRecord): WorkflowRunAgentClaims {
  const jwtClaims = run.compiledAccessScope.jwtClaims;
  let agentId = jwtClaims.agent_id;
  let agentVersion = jwtClaims.agent_version;

  if (!agentId && run.workflowStepId && run.compiledAccessScope.agentAssignments) {
    const stepAssignment = run.compiledAccessScope.agentAssignments.find((assignment) => assignment.stepId === run.workflowStepId);
    if (stepAssignment?.agentIds.length === 1) {
      agentId = stepAssignment.agentIds[0];
      agentVersion = stepAssignment.agentVersions[agentId];
    }
  }

  return {
    ...(agentId ? { agentId } : {}),
    ...(typeof agentVersion === 'number' ? { agentVersion } : {}),
    ...(jwtClaims.trigger_id ? { triggerId: jwtClaims.trigger_id } : {})
  };
}
