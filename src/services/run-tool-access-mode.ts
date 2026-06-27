import { config } from '../config.js';
import { ToolAccessMode } from '../types/domain.js';
import { WorkspaceAuthorization } from '../auth/workspace-authorization.js';
import { WorkspaceCapability } from '../auth/authorization.js';

export function parseToolAccessMode(value: unknown): ToolAccessMode | undefined {
  return value === 'read_only' || value === 'read_write' ? value : undefined;
}

export function capabilityForToolAccessMode(toolAccessMode: ToolAccessMode): WorkspaceCapability {
  return toolAccessMode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
}

export function missingToolAccessModeCapabilityMessage(toolAccessMode: ToolAccessMode): string {
  return toolAccessMode === 'read_write'
    ? 'Only workspace roles with read-write run capability can request read-write troubleshooting runs'
    : 'Only workspace roles with run creation capability can request troubleshooting runs';
}

export function resolveRunToolAccessMode(
  authz: WorkspaceAuthorization,
  requestedToolAccessMode?: ToolAccessMode
): ToolAccessMode {
  const defaultToolAccessMode: ToolAccessMode = config.SEED_DEVELOPMENT_DATA ? 'read_write' : 'read_only';
  let toolAccessMode = requestedToolAccessMode || defaultToolAccessMode;
  if (
    toolAccessMode === 'read_write'
    && requestedToolAccessMode === undefined
    && !authz.can('create_read_write_runs')
    && authz.can('create_read_only_runs')
  ) {
    toolAccessMode = 'read_only';
  }
  return toolAccessMode;
}
