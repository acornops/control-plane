import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { pruneTemplateInstallationRecordReference } from './repository-automation-templates.js';
import { withTransaction } from './repository-transaction.js';

export interface AgentWorkflowDependency {
  id: string;
  name: string;
  relation: 'selected_agent';
}

export async function listActiveAgentConversationRunIds(
  workspaceId: string,
  agentId: string,
  queryable: Queryable = db
): Promise<string[]> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM runs
     WHERE workspace_id=$1 AND agent_id=$2 AND conversation_kind='agent_chat'
       AND status IN ('queued','dispatching','running','waiting_for_approval','cancelling')
     ORDER BY requested_at,id`,
    [workspaceId, agentId]
  );
  return result.rows.map((row) => row.id);
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
  agentId: string,
  onLockedReadyToDelete?: () => Promise<void>
): Promise<
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'conflict'; workflows: AgentWorkflowDependency[] }
  | { status: 'active_runs'; runIds: string[] }
> {
  return withTransaction(async (client) => {
    const locked = await client.query(
      'SELECT 1 FROM agent_definitions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId, agentId]
    );
    if (!locked.rowCount) return { status: 'not_found' } as const;
    const workflows = await listAgentWorkflowDependencies(workspaceId, agentId, client);
    if (workflows.length > 0) return { status: 'conflict', workflows } as const;
    const runIds = await listActiveAgentConversationRunIds(workspaceId, agentId, client);
    if (runIds.length > 0) return { status: 'active_runs', runIds } as const;
    // Keep the Agent row locked while external installations are removed so a
    // new direct run cannot snapshot the Agent between this guard and deletion.
    await onLockedReadyToDelete?.();

    await client.query(
      `DELETE FROM sessions
       WHERE workspace_id=$1 AND agent_id=$2 AND conversation_kind='agent_chat'`,
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
