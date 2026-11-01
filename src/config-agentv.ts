import type { z } from 'zod';
import { agentVSystemdConfigFields, validateAgentVSystemdConfig } from './config-agentv-systemd.js';
import { windowsAgentVConfigFields, validateWindowsAgentVConfig } from './config-agentv-windows.js';
export { normalizeAgentVSystemdConfig } from './config-agentv-systemd.js';

export const agentVConfigFields = { ...agentVSystemdConfigFields, ...windowsAgentVConfigFields };

export function validateAgentVConfig(
  ctx: z.RefinementCtx,
  value: Parameters<typeof validateAgentVSystemdConfig>[1] & Parameters<typeof validateWindowsAgentVConfig>[1]
): void {
  validateAgentVSystemdConfig(ctx, value);
  validateWindowsAgentVConfig(ctx, value);
}
