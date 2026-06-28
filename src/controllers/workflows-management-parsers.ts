import {
  WorkflowCapabilityMode,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowStepDefinition
} from '../types/workflows.js';

const WORKFLOW_CATEGORIES: WorkflowCategory[] = [
  'cluster-triage',
  'git-operations',
  'workspace-audit',
  'knowledge-capture',
  'release-operations',
  'incident-review',
  'security-review'
];

export function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function workflowCategory(value: unknown): WorkflowCategory | undefined {
  return typeof value === 'string' && WORKFLOW_CATEGORIES.includes(value as WorkflowCategory)
    ? value as WorkflowCategory
    : undefined;
}

export function workflowStatus(value: unknown): WorkflowDefinitionForAccess['status'] | undefined {
  return value === 'active' || value === 'draft' || value === 'paused' ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function workflowInputs(value: unknown): WorkflowInputDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      label: typeof entry.label === 'string' ? entry.label.trim() : '',
      type: typeof entry.type === 'string' ? entry.type as WorkflowInputDefinition['type'] : 'text',
      required: entry.required !== false,
      optionSource: typeof entry.optionSource === 'string' ? entry.optionSource : undefined
    }))
    .filter((entry) => entry.name && entry.label);
}

export function workflowOutputArtifacts(value: unknown): WorkflowStepDefinition['outputArtifacts'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      type: typeof entry.type === 'string' ? entry.type.trim() : 'markdown',
      title: typeof entry.title === 'string' ? entry.title.trim() : '',
      required: entry.required === true
    }))
    .filter((entry) => entry.id && entry.title);
}

export function workflowSteps(value: unknown): WorkflowStepDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const targetBinding = entry.targetBinding && typeof entry.targetBinding === 'object' && !Array.isArray(entry.targetBinding)
        ? entry.targetBinding as WorkflowStepDefinition['targetBinding']
        : undefined;
      return {
        id: typeof entry.id === 'string' ? entry.id.trim() : '',
        title: typeof entry.title === 'string' ? entry.title.trim() : '',
        requiredInputs: stringList(entry.requiredInputs) || [],
        assignedAgentIds: stringList(entry.assignedAgentIds),
        targetBinding,
        enabledSkills: stringList(entry.enabledSkills) || [],
        allowedMcpServers: stringList(entry.allowedMcpServers) || [],
        allowedTools: stringList(entry.allowedTools) || [],
        contextGrants: stringList(entry.contextGrants) || [],
        approvalRequired: entry.approvalRequired === true,
        outputArtifacts: workflowOutputArtifacts(entry.outputArtifacts)
      };
    })
    .filter((entry) => entry.id && entry.title);
}

export function workflowCapabilityMode(value: unknown): WorkflowCapabilityMode | undefined {
  return value === 'read_only' || value === 'read_write' ? value : undefined;
}
