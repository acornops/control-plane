import type { AuthenticatedRequest } from '../auth/middleware.js';
import type {
  WorkflowCapabilityMode,
  WorkflowCategory,
  WorkflowDefinitionForAccess,
  WorkflowInputDefinition,
  WorkflowStepDefinition
} from '../types/workflows.js';

const WORKFLOW_CATEGORIES: WorkflowCategory[] = [
  'cluster-triage', 'git-operations', 'workspace-audit', 'knowledge-capture',
  'release-operations', 'incident-review', 'security-review'
];

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim()).filter(Boolean);
}

function workflowCategory(value: unknown): WorkflowCategory | undefined {
  return typeof value === 'string' && WORKFLOW_CATEGORIES.includes(value as WorkflowCategory)
    ? value as WorkflowCategory : undefined;
}

function workflowStatus(value: unknown): WorkflowDefinitionForAccess['status'] | undefined {
  return value === 'active' || value === 'draft' || value === 'paused' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function workflowInputs(value: unknown): WorkflowInputDefinition[] | undefined {
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

function workflowOutputArtifacts(value: unknown): WorkflowStepDefinition['outputArtifacts'] | undefined {
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

export function requestWorkflowScopeUpdate(req: AuthenticatedRequest, workflow: WorkflowDefinitionForAccess) {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const policyInput = body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
    ? body.policy as Record<string, unknown> : {};
  const mode: WorkflowCapabilityMode | undefined = policyInput.mode === 'read_only' || policyInput.mode === 'read_write'
    ? policyInput.mode : undefined;
  const approvalRequirements = stringList(policyInput.approvalRequirements);
  const maxRuntimeSeconds = numberValue(policyInput.maxRuntimeSeconds);
  const retentionDays = numberValue(policyInput.retentionDays);
  const stepInputs = Array.isArray(body.steps) ? body.steps : [];
  const knownStepIds = new Set(workflow.steps.map((step) => step.id));
  const steps = stepInputs
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      title: typeof entry.title === 'string' ? entry.title.trim() : undefined,
      requiredInputs: stringList(entry.requiredInputs),
      agentIds: stringList(entry.agentIds),
      targetBinding: entry.targetBinding && typeof entry.targetBinding === 'object' && !Array.isArray(entry.targetBinding)
        ? entry.targetBinding as WorkflowStepDefinition['targetBinding'] : undefined,
      enabledSkills: stringList(entry.enabledSkills),
      allowedMcpServers: stringList(entry.allowedMcpServers),
      allowedTools: stringList(entry.allowedTools),
      contextGrants: stringList(entry.contextGrants),
      approvalRequired: typeof entry.approvalRequired === 'boolean' ? entry.approvalRequired : undefined,
      outputArtifacts: workflowOutputArtifacts(entry.outputArtifacts)
    }));
  return {
    update: {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      status: workflowStatus(body.status),
      category: workflowCategory(body.category),
      tags: stringList(body.tags),
      inputs: workflowInputs(body.inputs),
      enabledMcpServers: stringList(body.enabledMcpServers),
      enabledSkills: stringList(body.enabledSkills),
      requiredPermissions: stringList(body.requiredPermissions) as WorkflowDefinitionForAccess['requiredPermissions'] | undefined,
      policy: mode || approvalRequirements || maxRuntimeSeconds || retentionDays
        ? { mode, approvalRequirements, maxRuntimeSeconds, retentionDays } : undefined,
      steps,
      starterPrompt: typeof body.starterPrompt === 'string' ? body.starterPrompt : undefined
    },
    unknownStepId: steps.find((step) => !knownStepIds.has(step.id))?.id
  };
}
