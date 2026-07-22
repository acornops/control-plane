import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import {
  listWorkflowSchedules,
  pauseWorkflowScheduleForConfigurationChange
} from '../store/repository-workflow-schedules.js';
import { listWorkflowDefinitions } from '../store/repository-workflows.js';

export async function pauseSchedulesForAgentIndividualCredentials(input: {
  workspaceId: string;
  agentId: string;
  serverId: string;
  serverName: string;
  actorUserId: string;
}): Promise<string[]> {
  const [workflows, schedules] = await Promise.all([
    listWorkflowDefinitions(input.workspaceId),
    listWorkflowSchedules(input.workspaceId)
  ]);
  const workflowIds = new Set(
    workflows
      .filter((workflow) => workflow.agentIds.includes(input.agentId))
      .map((workflow) => workflow.id)
  );
  const error = `MCP server ${input.serverId} now uses individual credentials. Connect the schedule owner's credential before resuming.`;
  const pausedScheduleIds: string[] = [];
  for (const schedule of schedules) {
    if (schedule.status !== 'enabled' || !workflowIds.has(schedule.workflowId)) continue;
    const paused = await pauseWorkflowScheduleForConfigurationChange(
      schedule.id,
      error,
      input.actorUserId
    );
    if (!paused) continue;
    pausedScheduleIds.push(paused.id);
    await recordWorkspaceAuditEvent({
      workspaceId: input.workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_auto_paused.v1',
      operation: 'write',
      actorUserId: input.actorUserId,
      objectType: 'workflow_schedule',
      objectId: paused.id,
      objectName: paused.name,
      summary: 'Workflow schedule paused after MCP credential ownership changed',
      metadata: {
        workflowId: paused.workflowId,
        reason: 'mcp_credential_mode_changed',
        agentId: input.agentId,
        serverId: input.serverId,
        serverName: input.serverName
      }
    });
  }
  return pausedScheduleIds;
}
