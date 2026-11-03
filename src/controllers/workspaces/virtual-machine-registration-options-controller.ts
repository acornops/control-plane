import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireWorkspaceCapability } from '../../auth/workspace-authorization.js';
import { config } from '../../config.js';
import { windowsAgentVConfigSchema } from '../../config-agentv-windows.js';
import { toSingleParam } from '../../utils/params.js';

/** Return deployment availability without release coordinates or credentials. */
export async function getVirtualMachineRegistrationOptions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_targets', 'Target management permission is required to read VM registration options'))) return;
    const platforms: Array<{ osFamily: string; serviceManager: string; accessModes: string[] }> = [
      { osFamily: 'linux', serviceManager: 'systemd', accessModes: ['read_only', 'read_write'] }
    ];
    if (config.AGENTV_WINDOWS_ENABLED && windowsAgentVConfigSchema.safeParse(config).success) {
      platforms.push({ osFamily: 'windows', serviceManager: 'scm', accessModes: ['read_only'] });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ platforms });
  } catch (error) { next(error); }
}
