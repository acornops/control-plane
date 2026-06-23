import { logger } from '../logger.js';
import { publishTargetChatActivityEvents } from './control-plane-coordination.js';
import { repo } from '../store/repository.js';
import { runtime } from '../store/runtime.js';
import { Run, RunToolApproval, TargetChatActivityEvent, TargetChatActivityEventType, TargetType } from '../types/domain.js';

function streamKey(workspaceId: string, targetId: string): string {
  return `target-chat:${workspaceId}:${targetId}`;
}

export function emitTargetChatActivityEvent(event: TargetChatActivityEvent): void {
  runtime.targetChatActivityStreams.emit(streamKey(event.workspaceId, event.targetId), { event });
}

export async function recordTargetChatActivityEvent(params: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  sessionId: string;
  runId?: string;
  messageId?: string;
  approvalId?: string;
  type: TargetChatActivityEventType;
  payload?: Record<string, unknown>;
}): Promise<TargetChatActivityEvent | null> {
  let event: TargetChatActivityEvent;
  try {
    event = await repo.insertTargetChatActivityEvent(params);
  } catch (err) {
    logger.warn(
      {
        err,
        workspaceId: params.workspaceId,
        targetId: params.targetId,
        sessionId: params.sessionId,
        runId: params.runId,
        approvalId: params.approvalId,
        type: params.type
      },
      'Failed recording target chat activity event'
    );
    return null;
  }

  emitTargetChatActivityEvent(event);
  try {
    await publishTargetChatActivityEvents(event.workspaceId, event.targetId, [event]);
  } catch (err) {
    logger.warn(
      {
        err,
        workspaceId: event.workspaceId,
        targetId: event.targetId,
        sessionId: event.sessionId,
        runId: event.runId,
        approvalId: event.approvalId,
        type: event.type
      },
      'Failed publishing target chat activity event'
    );
  }
  return event;
}

export function recordRunStatusChangedActivity(previous: Run, next: Run | null): Promise<TargetChatActivityEvent | null | undefined> {
  if (!next || previous.status === next.status) return Promise.resolve(undefined);
  return recordTargetChatActivityEvent({
    workspaceId: next.workspaceId,
    targetId: next.targetId,
    targetType: next.targetType,
    sessionId: next.sessionId,
    runId: next.id,
    messageId: next.messageId,
    type: 'run.status_changed',
    payload: {
      previousStatus: previous.status,
      status: next.status,
      toolAccessMode: next.toolAccessMode,
      requestedAt: next.requestedAt,
      startedAt: next.startedAt || null,
      endedAt: next.endedAt || null,
      errorCode: next.errorCode || null
    }
  });
}

export function recordApprovalActivity(
  approval: RunToolApproval,
  type: Extract<TargetChatActivityEventType, 'approval.requested' | 'approval.decided' | 'approval.expired'>,
  sessionId: string,
  messageId?: string
): Promise<TargetChatActivityEvent | null> {
  return recordTargetChatActivityEvent({
    workspaceId: approval.workspaceId,
    targetId: approval.targetId,
    targetType: approval.targetType,
    sessionId,
    runId: approval.runId,
    messageId,
    approvalId: approval.id,
    type,
    payload: {
      status: approval.status,
      decision: approval.decision || null,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      summary: approval.summary || null,
      requestedBy: approval.requestedBy || null,
      decidedBy: approval.decidedBy || null,
      expiresAt: approval.expiresAt,
      decidedAt: approval.decidedAt || null
    }
  });
}

export function targetChatActivityStreamKey(workspaceId: string, targetId: string): string {
  return streamKey(workspaceId, targetId);
}
