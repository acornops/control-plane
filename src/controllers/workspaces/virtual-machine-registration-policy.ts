import type { Response } from 'express';
import { config } from '../../config.js';

export function allowVirtualMachineRegistration(osFamily: unknown, res: Response): boolean {
  if (osFamily !== 'windows' || (config.AGENTV_WINDOWS_ENABLED
    && config.AGENTV_WINDOWS_RELEASE_VERSION && config.AGENTV_WINDOWS_RELEASE_BASE_URL)) return true;
  res.status(409).json({
    error: { code: 'WINDOWS_AGENTV_DISABLED', message: 'Windows AgentV rollout is disabled or unqualified', retryable: false }
  });
  return false;
}
