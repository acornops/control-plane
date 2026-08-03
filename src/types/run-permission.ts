export const RUN_PERMISSION_MODES = [
  'read_only',
  'ask_before_changes',
  'auto_allowed_changes'
] as const;

export type RunPermissionMode = (typeof RUN_PERMISSION_MODES)[number];

export function isRunPermissionMode(value: unknown): value is RunPermissionMode {
  return typeof value === 'string'
    && RUN_PERMISSION_MODES.includes(value as RunPermissionMode);
}
