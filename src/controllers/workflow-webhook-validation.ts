export const WORKFLOW_WEBHOOK_CREATE_FIELDS = new Set([
  'workflowId',
  'name',
  'enabled',
  'approvedContextGrants'
]);

export const WORKFLOW_WEBHOOK_UPDATE_FIELDS = new Set([
  'workspaceId',
  'name',
  'enabled',
  'approvedContextGrants'
]);

export const WORKFLOW_WEBHOOK_WORKSPACE_FIELDS = new Set(['workspaceId']);

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

export function validateWorkflowWebhookContextGrants(
  requiredGrants: string[],
  approvedGrants: string[]
): string | null {
  const required = new Set(requiredGrants);
  const missing = requiredGrants.find((grant) => !approvedGrants.includes(grant));
  if (missing) return `Approve the ${missing} context grant required by this workflow.`;
  const unknown = approvedGrants.find((grant) => !required.has(grant));
  return unknown ? `${unknown} is not used by this workflow.` : null;
}
