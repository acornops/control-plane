import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { pruneTemplateInstallationRecordReference } from './repository-automation-templates.js';
import { withTransaction } from './repository-transaction.js';

export interface AgentWorkflowDependency {
  id: string;
  name: string;
  relation: 'selected_agent';
}

interface Queryable {
  query: PoolClient['query'];
}

export async function listAgentWorkflowDependencies(
  workspaceId: string,
  agentId: string,
  queryable: Queryable = db
): Promise<AgentWorkflowDependency[]> {
  const result = await queryable.query<{
    id: string;
    name: string;
    relation: AgentWorkflowDependency['relation'];
  }>(
    `SELECT id,name,'selected_agent' AS relation
     FROM workflow_definitions
     WHERE workspace_id=$1
       AND agent_ids ? $2
     ORDER BY name,id`,
    [workspaceId, agentId]
  );
  return result.rows;
}

export async function deleteAgentWithInstallationCleanup(
  workspaceId: string,
  agentId: string
): Promise<
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'conflict'; workflows: AgentWorkflowDependency[] }
> {
  return withTransaction(async (client) => {
    const locked = await client.query(
      'SELECT 1 FROM agent_definitions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId, agentId]
    );
    if (!locked.rowCount) return { status: 'not_found' } as const;
    const workflows = await listAgentWorkflowDependencies(workspaceId, agentId, client);
    if (workflows.length > 0) return { status: 'conflict', workflows } as const;

    await client.query(
      'DELETE FROM agent_definitions WHERE workspace_id=$1 AND id=$2',
      [workspaceId, agentId]
    );
    await pruneTemplateInstallationRecordReference(workspaceId, agentId, client);
    return { status: 'deleted' } as const;
  });
}
