export const WORKFLOW_WEBHOOK_CREATE_FIELDS = new Set([
  'workflowId',
  'name',
  'enabled'
]);

export const WORKFLOW_WEBHOOK_UPDATE_FIELDS = new Set([
  'workspaceId',
  'name',
  'enabled'
]);

export const WORKFLOW_WEBHOOK_WORKSPACE_FIELDS = new Set(['workspaceId']);

export function unexpectedBodyField(
  body: Record<string, unknown>,
  allowedFields: ReadonlySet<string>
): string | undefined {
  return Object.keys(body).find((field) => !allowedFields.has(field));
}
