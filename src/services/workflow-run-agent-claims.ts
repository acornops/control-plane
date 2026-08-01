import type { WorkflowRunRecord } from '../store/repository-workflows.js';

export interface WorkflowRunAgentClaims {
  agentId?: string;
  triggerId?: string;
}

export function workflowRunAgentClaims(run: WorkflowRunRecord): WorkflowRunAgentClaims {
  const jwtClaims = run.compiledAccessScope.jwtClaims;
  return {
    ...(run.agentId || jwtClaims.agent_id ? { agentId: run.agentId || jwtClaims.agent_id } : {}),
    ...(jwtClaims.trigger_id ? { triggerId: jwtClaims.trigger_id } : {})
  };
}
