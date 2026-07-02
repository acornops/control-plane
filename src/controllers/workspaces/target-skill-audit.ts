import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { TargetSkillSource, TargetType } from '../../types/domain.js';

export async function recordTargetSkillAudit(input: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  actorUserId: string;
  eventType:
    | 'skill.created.v1'
    | 'skill.updated.v1'
    | 'skill.deleted.v1'
    | 'skill.imported.v1'
    | 'skill.reimported.v1'
    | 'skill.enabled.v1'
    | 'skill.disabled.v1';
  operation: 'read' | 'write';
  skill: {
    id: string;
    name: string;
    enabled: boolean;
    validationStatus: 'valid' | 'invalid';
    source: TargetSkillSource;
  };
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'tool',
    eventType: input.eventType,
    operation: input.operation,
    actorUserId: input.actorUserId,
    objectType: 'target_skill',
    objectId: input.skill.id,
    objectName: input.skill.name,
    summary: input.summary,
    metadata: {
      targetId: input.targetId,
      targetType: input.targetType,
      enabled: input.skill.enabled,
      validationStatus: input.skill.validationStatus,
      sourceType: input.skill.source.type,
      provider: input.skill.source.provider || null,
      repoUrl: input.skill.source.repoUrl || null,
      apiBaseUrl: input.skill.source.apiBaseUrl || null,
      ref: input.skill.source.ref || null,
      subpath: input.skill.source.subpath || null,
      commitSha: input.skill.source.commitSha || null,
      syncStatus: input.skill.source.syncStatus,
      ...(input.metadata || {})
    }
  });
}
