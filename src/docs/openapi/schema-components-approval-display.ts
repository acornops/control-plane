import { dateTime, type JsonSchema, schemaRef, uuid } from './schema-types.js';

const approvalUser: JsonSchema = {
  type: 'object',
  required: ['id', 'displayName'],
  properties: { id: { type: 'string' }, displayName: { type: 'string' } },
  additionalProperties: false
};

export const approvalDisplayProperties: Record<string, JsonSchema> = {
  requestedByUser: approvalUser,
  decidedByUser: approvalUser,
  workspaceName: { type: 'string', description: 'Optional current workspace display name; workspaceId remains authoritative.' },
  targetName: { type: 'string', description: 'Optional current name of a referenced target in the approval workspace.' }
};

export function buildWorkspaceApprovalSchemas(): Record<string, JsonSchema> {
  return {
    WorkspaceApprovalInbox: {
      type: 'object',
      required: ['items', 'pendingCount'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkspaceApprovalInboxRow') },
        pendingCount: { type: 'integer', minimum: 0 },
        nextCursor: { type: 'string' }
      }
    },
    WorkspaceApprovalInboxRow: {
      type: 'object',
      required: ['approvalId', 'runId', 'source', 'status', 'summary'],
      properties: {
        ...approvalDisplayProperties,
        approvalId: uuid,
        runId: uuid,
        source: { type: 'string', enum: ['interactive_tool', 'workflow_gate', 'agent_gate', 'agent_tool', 'workflow_tool'] },
        workflowId: { type: 'string', example: 'workflow-cluster-daily-triage' },
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        executionStatus: { type: 'string', enum: ['not_started', 'executing', 'succeeded', 'failed', 'unknown'] },
        summary: { type: 'string' },
        toolName: { type: 'string' },
        requestedBy: { type: 'string' },
        expiresAt: dateTime,
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        decidedBy: { type: 'string' },
        decidedAt: dateTime,
        requestedAt: dateTime
      },
      additionalProperties: true
    }
  };
}
