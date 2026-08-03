import type { ToolAccessMode } from '../types/domain.js';
import type { RunPermissionMode } from '../types/run-permission.js';

const permissionRank: Record<RunPermissionMode, number> = {
  read_only: 0,
  ask_before_changes: 1,
  auto_allowed_changes: 2
};

export function narrowRunPermissionModes(
  ...modes: RunPermissionMode[]
): RunPermissionMode {
  return modes.reduce<RunPermissionMode>((effective, mode) => (
    permissionRank[mode] < permissionRank[effective] ? mode : effective
  ), 'auto_allowed_changes');
}

export function permissionModeForAccess(accessMode: ToolAccessMode): RunPermissionMode {
  return accessMode === 'read_only' ? 'read_only' : 'auto_allowed_changes';
}

export function permissionModeForLegacyWriteConfirmation(required: boolean): RunPermissionMode {
  return required ? 'ask_before_changes' : 'auto_allowed_changes';
}

export function legacyWriteConfirmationRequired(permissionMode: RunPermissionMode): boolean {
  return permissionMode !== 'auto_allowed_changes';
}

export function resolveEffectiveRunPermissionMode(input: {
  accessMode: ToolAccessMode;
  policies: RunPermissionMode[];
  forceApproval?: boolean;
}): RunPermissionMode {
  return narrowRunPermissionModes(
    permissionModeForAccess(input.accessMode),
    ...input.policies,
    ...(input.forceApproval ? ['ask_before_changes' as const] : [])
  );
}

export function permissionModeAllowsAccess(
  permissionMode: RunPermissionMode,
  accessMode: ToolAccessMode
): boolean {
  return resolveEffectiveRunPermissionMode({ accessMode, policies: [permissionMode] }) !== 'read_only'
    || accessMode === 'read_only';
}

export function permissionModeRequiresWriteApproval(permissionMode: RunPermissionMode): boolean {
  return permissionMode === 'ask_before_changes';
}
