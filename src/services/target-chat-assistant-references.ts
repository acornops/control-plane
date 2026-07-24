import { repo } from '../store/repository.js';
import type { TargetType, ToolAccessMode } from '../types/domain.js';
import type { AssistantReference } from '../types/assistant-references.js';
import { resolveTargetRunTools } from './target-run-tool-resolution.js';

export interface AssistantReferenceRequest {
  kind: 'tool' | 'skill';
  id: string;
}

export class InvalidAssistantReferenceError extends Error {
  constructor(readonly references: AssistantReferenceRequest[]) {
    super('One or more referenced tools or skills are no longer available for this target.');
    this.name = 'InvalidAssistantReferenceError';
  }
}

export async function resolveTargetChatAssistantReferences(params: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  toolAccessMode: ToolAccessMode;
  references: AssistantReferenceRequest[];
}): Promise<AssistantReference[]> {
  if (params.references.length === 0) return [];

  const [toolResolution, skills] = await Promise.all([
    resolveTargetRunTools({
      workspaceId: params.workspaceId,
      targetId: params.targetId,
      targetType: params.targetType,
      toolAccessMode: params.toolAccessMode,
      strictMcpResolution: true,
      resyncIfEmpty: false
    }),
    repo.listEnabledValidTargetSkillSummaries(params.targetId)
  ]);
  const toolSpecs = new Map(toolResolution.allowedToolSpecs.map((tool) => [tool.name, tool]));
  const toolPreviews = new Map(toolResolution.previewItems.map((tool) => [tool.name, tool]));
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const invalid: AssistantReferenceRequest[] = [];
  const resolved: AssistantReference[] = [];

  for (const reference of params.references) {
    if (reference.kind === 'tool') {
      const tool = toolSpecs.get(reference.id);
      const preview = toolPreviews.get(reference.id);
      if (!preview) {
        invalid.push(reference);
        continue;
      }
      resolved.push({
        kind: 'tool',
        id: preview.name,
        label: preview.label || preview.name,
        description: preview.description,
        capability: preview.capability,
        source: preview.source,
        ...(tool?.server_id ? { serverId: tool.server_id } : {}),
        ...(tool?.tool_name ? { toolName: tool.tool_name } : {})
      });
      continue;
    }

    const skill = skillsById.get(reference.id);
    if (!skill) {
      invalid.push(reference);
      continue;
    }
    resolved.push({
      kind: 'skill',
      id: skill.id,
      label: skill.name,
      description: skill.description,
      source: skill.source.type
    });
  }

  if (invalid.length > 0) throw new InvalidAssistantReferenceError(invalid);
  return resolved;
}
