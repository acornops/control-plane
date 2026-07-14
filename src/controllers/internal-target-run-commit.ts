import { recordTargetChatActivityEvent } from '../services/target-chat-activity-events.js';
import { repo } from '../store/repository.js';
import type { Run } from '../types/domain.js';

export async function commitTargetAssistantFinalMessage(
  run: Run,
  status: string,
  content: string
): Promise<void> {
  const message = await repo.upsertAssistantFinalMessage(run.sessionId, run.id, content);
  await recordTargetChatActivityEvent({
    workspaceId: run.workspaceId,
    targetId: run.targetId,
    targetType: run.targetType,
    sessionId: run.sessionId,
    runId: run.id,
    messageId: message.id,
    type: 'assistant_message.committed',
    payload: {
      status,
      contentLength: content.length,
      committedAt: new Date().toISOString()
    }
  });
}
