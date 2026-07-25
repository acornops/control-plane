import type {
  WorkflowEventInputBinding,
  WorkflowParameterDefinition
} from '../types/workflows.js';

const INPUT_BINDINGS = new Set<WorkflowEventInputBinding>([
  'issue.id',
  'issue.title',
  'issue.summary',
  'issue.severity',
  'issue.scope',
  'issue.object',
  'target.id',
  'target.type'
]);

export const EVENT_TRIGGER_CREATE_FIELDS = new Set([
  'workflowId',
  'name',
  'enabled',
  'sourceType',
  'eventType',
  'inputBindings',
  'approvedContextGrants'
]);

export const EVENT_TRIGGER_UPDATE_FIELDS = new Set([
  'workspaceId',
  'name',
  'enabled',
  'inputBindings',
  'approvedContextGrants'
]);

export const EVENT_TRIGGER_WORKSPACE_FIELDS = new Set(['workspaceId']);

export function unexpectedBodyField(
  body: Record<string, unknown>,
  allowedFields: ReadonlySet<string>
): string | undefined {
  return Object.keys(body).find((field) => !allowedFields.has(field));
}

export function parseContextGrantList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const grants: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || grants.includes(item.trim())) return null;
    grants.push(item.trim());
  }
  return grants;
}

export function parseEventInputBindings(
  value: unknown
): Record<string, WorkflowEventInputBinding> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bindings: Record<string, WorkflowEventInputBinding> = {};
  for (const [key, binding] of Object.entries(value)) {
    if (!key.trim() || typeof binding !== 'string' || !INPUT_BINDINGS.has(binding as WorkflowEventInputBinding)) {
      return null;
    }
    bindings[key] = binding as WorkflowEventInputBinding;
  }
  return bindings;
}

export function validateIssueBindings(
  parameters: WorkflowParameterDefinition[],
  bindings: Record<string, WorkflowEventInputBinding>
): string | null {
  if (parameters.some((parameter) => parameter.type === 'chat')) {
    return 'Issue event triggers do not support workflows with chat parameters.';
  }
  const expectedKeys = new Set(parameters.map((parameter) => parameter.key));
  for (const parameter of parameters) {
    const binding = bindings[parameter.key];
    if (!binding) return `Select an issue field for ${parameter.key}.`;
    if (parameter.type === 'target' && binding !== 'target.id') {
      return `${parameter.key} is a target parameter and must use the target ID.`;
    }
  }
  const unknown = Object.keys(bindings).find((key) => !expectedKeys.has(key));
  return unknown ? `${unknown} is not declared by the selected workflow.` : null;
}

export function validateEventTriggerContextGrants(
  requiredGrants: string[],
  approvedGrants: string[]
): string | null {
  const required = new Set(requiredGrants);
  const missing = requiredGrants.find((grant) => !approvedGrants.includes(grant));
  if (missing) return `Approve the ${missing} context grant required by this workflow.`;
  const unknown = approvedGrants.find((grant) => !required.has(grant));
  return unknown ? `${unknown} is not used by this workflow.` : null;
}
