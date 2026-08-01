import { recordTargetChatActivityEvent } from '../services/target-chat-activity-events.js';
import { repo } from '../store/repository.js';
import type { Run } from '../types/domain.js';

export async function commitInteractiveAssistantFinalMessage(
  run: Run,
  status: string,
  content: string
): Promise<void> {
  const message = await repo.upsertAssistantFinalMessage(run.sessionId, run.id, content);
  if (run.conversationKind === 'agent_chat' || !run.targetId || !run.targetType) return;
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
