import { recordWorkspaceAuditEvent } from '../workspace-audit.js';
import { TargetType } from '../../types/domain.js';

interface KnowledgeBankAuditInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  actorUserId?: string | null;
  actorType?: 'user' | 'system';
  eventType: string;
  operation?: 'read' | 'write';
  objectId?: string | null;
  objectName?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function recordKnowledgeBankAudit(input: KnowledgeBankAuditInput): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'knowledge',
    eventType: input.eventType,
    operation: input.operation || 'write',
    actorUserId: input.actorUserId || null,
    actorType: input.actorType,
    objectType: 'knowledge_bank',
    objectId: input.objectId || input.targetId,
    objectName: input.objectName || null,
    summary: input.summary,
    metadata: {
      targetId: input.targetId,
      targetType: input.targetType,
      ...(input.metadata || {})
    }
  });
}
