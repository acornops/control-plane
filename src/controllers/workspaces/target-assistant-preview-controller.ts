import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import {
  capabilityForToolAccessMode,
  missingToolAccessModeCapabilityMessage,
  parseToolAccessMode
} from '../../services/run-tool-access-mode.js';
import { resolveTargetRunTools } from '../../services/target-run-tool-resolution.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';

export async function getTargetAssistantToolPreview(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (
      access.target.targetType !== KUBERNETES_TARGET_TYPE
      && access.target.targetType !== VIRTUAL_MACHINE_TARGET_TYPE
    ) {
      res.status(400).json({
        error: {
          code: 'UNSUPPORTED_TARGET_TYPE',
          message: `Troubleshooting runs are not available for target_type=${access.target.targetType} yet`,
          retryable: false
        }
      });
      return;
    }

    const rawToolAccessMode = toSingleParam(req.query.toolAccessMode as string | string[] | undefined);
    const toolAccessMode = parseToolAccessMode(rawToolAccessMode);
    if (!toolAccessMode) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'toolAccessMode must be either read_only or read_write',
          retryable: false
        }
      });
      return;
    }

    const runCapability = capabilityForToolAccessMode(toolAccessMode);
    if (!access.authz.can(runCapability)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: missingToolAccessModeCapabilityMessage(toolAccessMode),
          retryable: false
        }
      });
      return;
    }

    const resolution = await resolveTargetRunTools({
      workspaceId,
      targetId: access.target.id,
      targetType: access.target.targetType,
      toolAccessMode
    });
    res.status(200).json({
      workspaceId,
      targetId: access.target.id,
      targetType: access.target.targetType,
      toolAccessMode,
      targetSupportsWrite: resolution.targetSupportsWrite,
      confirmationRequiredForWrite: resolution.confirmationRequiredForWrite,
      approvalTimeoutSeconds: resolution.approvalTimeoutSeconds,
      writeUnavailableReason: resolution.writeUnavailableReason,
      summary: resolution.summary,
      items: resolution.previewItems
    });
  } catch (err) {
    next(err);
  }
}
