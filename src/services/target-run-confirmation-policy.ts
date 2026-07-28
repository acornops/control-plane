import type { Run } from '../types/domain.js';

export function resolveTargetRunConfirmationPolicy(
  run: Pick<Run, 'toolAccessMode' | 'confirmationRequiredForWriteOverride'>,
  targetConfirmationRequired: boolean
): {
  confirmationRequiredForWrite: boolean;
  permissionMode: 'read_only' | 'ask_before_changes' | 'auto_allowed_changes';
} {
  const confirmationRequiredForWrite = targetConfirmationRequired
    || run.confirmationRequiredForWriteOverride === true;
  const permissionMode = run.toolAccessMode === 'read_only'
    ? 'read_only'
    : confirmationRequiredForWrite
      ? 'ask_before_changes'
      : 'auto_allowed_changes';
  return { confirmationRequiredForWrite, permissionMode };
}
