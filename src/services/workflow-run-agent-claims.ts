import type { WorkflowRunRecord } from '../store/repository-workflows.js';

export interface WorkflowRunAgentClaims {
  agentId?: string;
  agentVersion?: number;
  triggerId?: string;
}

export function workflowRunAgentClaims(run: WorkflowRunRecord): WorkflowRunAgentClaims {
  const jwtClaims = run.compiledAccessScope.jwtClaims;
  return {
    ...(jwtClaims.agent_id ? { agentId: jwtClaims.agent_id } : {}),
    ...(typeof jwtClaims.agent_version === 'number' ? { agentVersion: jwtClaims.agent_version } : {}),
    ...(jwtClaims.trigger_id ? { triggerId: jwtClaims.trigger_id } : {})
  };
}
