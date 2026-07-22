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
      `UPDATE agent_definitions manager
       SET delegate_agent_ids=COALESCE((
         SELECT jsonb_agg(delegate_id)
         FROM jsonb_array_elements_text(manager.delegate_agent_ids) delegate_id
         WHERE delegate_id <> $2
       ), '[]'::jsonb)
       WHERE manager.workspace_id=$1
         AND manager.kind='manager'
         AND manager.delegate_agent_ids ? $2`,
      [workspaceId, agentId]
    );
    await client.query(
      'DELETE FROM agent_definitions WHERE workspace_id=$1 AND id=$2',
      [workspaceId, agentId]
    );
    await pruneTemplateInstallationRecordReference(workspaceId, agentId, client);
    return { status: 'deleted' } as const;
  });
}

export async function deleteWorkflowWithInternalManagerCleanup(
  workspaceId: string,
  workflowId: string
): Promise<{ status: 'deleted' | 'not_found'; removedInternalManagerId?: string }> {
  return withTransaction(async (client) => {
    const workflow = await client.query<{ entry_agent_id: string }>(
      `SELECT entry_agent_id FROM workflow_definitions
       WHERE workspace_id=$1 AND id=$2
       FOR UPDATE`,
      [workspaceId, workflowId]
    );
    if (!workflow.rowCount) return { status: 'not_found' } as const;

    await client.query(
      'DELETE FROM workflow_definitions WHERE workspace_id=$1 AND id=$2',
      [workspaceId, workflowId]
    );
    await pruneTemplateInstallationRecordReference(workspaceId, workflowId, client);

    return { status: 'deleted' } as const;
  });
}
