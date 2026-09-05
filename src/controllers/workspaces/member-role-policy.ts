import type { Response } from 'express';

import { isSupportedRole } from '../../auth/authorization.js';
import type { Role } from '../../types/domain.js';

export function sendUnsupportedRole(res: Response, role: string): void {
  res.status(400).json({
    error: {
      code: 'ROLE_NOT_SUPPORTED',
      message: `Workspace role is not supported by this deployment: ${role}`,
      retryable: false
    }
  });
}

export function roleFilterValue(role: string | undefined): Role | undefined {
  return role && isSupportedRole(role) ? role : undefined;
}
