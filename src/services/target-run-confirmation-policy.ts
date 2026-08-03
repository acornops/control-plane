import type { Run } from '../types/domain.js';
import type { RunPermissionMode } from '../types/run-permission.js';
import {
  permissionModeForLegacyWriteConfirmation,
  permissionModeRequiresWriteApproval,
  resolveEffectiveRunPermissionMode
} from './run-permission-policy.js';

export function resolveTargetRunConfirmationPolicy(
  run: Pick<Run, 'toolAccessMode' | 'confirmationRequiredForWriteOverride'>,
  targetPolicy: RunPermissionMode | boolean
): {
  confirmationRequiredForWrite: boolean;
  permissionMode: 'read_only' | 'ask_before_changes' | 'auto_allowed_changes';
} {
  const targetPermissionMode = typeof targetPolicy === 'boolean'
    ? permissionModeForLegacyWriteConfirmation(targetPolicy)
    : targetPolicy;
  const permissionMode = resolveEffectiveRunPermissionMode({
    accessMode: run.toolAccessMode,
    policies: [targetPermissionMode],
    forceApproval: run.confirmationRequiredForWriteOverride === true
  });
  const confirmationRequiredForWrite = permissionModeRequiresWriteApproval(permissionMode);
  return { confirmationRequiredForWrite, permissionMode };
}
