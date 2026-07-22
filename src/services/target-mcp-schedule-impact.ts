import { logger } from '../logger.js';
import {
  listWorkflowSchedules,
  pauseWorkflowScheduleForConfigurationChange
} from '../store/repository-workflow-schedules.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import { promptResourceRegistry } from './prompt-resources/index.js';
import { resolveRunPrincipal } from './run-principal.js';
import { getWorkflowScheduleMcpReadinessReport } from './workflow-schedule-readiness.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';

export async function pauseSchedulesForTargetIndividualCredentials(input: {
  workspaceId: string;
  targetId: string;
  serverId: string;
  serverName: string;
  actorUserId: string;
}): Promise<string[]> {
  const schedules = await listWorkflowSchedules(input.workspaceId);
  const pausedScheduleIds: string[] = [];
  for (const schedule of schedules) {
    if (schedule.status !== 'enabled') continue;
    try {
      const workflow = await getWorkflowDefinition(input.workspaceId, schedule.workflowId);
      if (!workflow) continue;
      const actor = await resolveRunPrincipal(input.workspaceId, schedule.principal);
      if (!actor) continue;
      const resolution = await promptResourceRegistry.resolve(schedule.controlMessage, {
        workspaceId: input.workspaceId,
        actorUserId: actor.userId,
        workflowId: workflow.id,
        source: 'trigger',
        mode: 'launch',
        requirements: workflow.resourceRequirements || []
      });
      if (resolution.blockers.length > 0) continue;
      const readiness = await getWorkflowScheduleMcpReadinessReport({
        workspaceId: input.workspaceId,
        workflow,
        actor,
        principal: schedule.principal,
        approvedContextGrants: schedule.approvedContextGrants,
        resolution
      });
      if (!readiness.failures.some((failure) => failure.serverId === input.serverId)) continue;
      const error = `MCP server ${input.serverName} now uses individual credentials. Connect the schedule owner's credential before resuming.`;
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
        summary: 'Workflow schedule paused after target MCP credential ownership changed',
        metadata: {
          workflowId: paused.workflowId,
          reason: 'target_mcp_credential_mode_changed',
          targetId: input.targetId,
          serverId: input.serverId,
          serverName: input.serverName
        }
      });
    } catch (error) {
      logger.warn({
        workspaceId: input.workspaceId,
        scheduleId: schedule.id,
        targetId: input.targetId,
        serverId: input.serverId,
        error
      }, 'Failed evaluating schedule impact for target MCP credential ownership change');
    }
  }
  return pausedScheduleIds;
}
