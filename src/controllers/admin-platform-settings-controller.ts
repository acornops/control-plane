import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import {
  PLATFORM_SETTING_KEYS,
  type PlatformSettingKey
} from '../config-platform-settings.js';
import { logger } from '../logger.js';
import {
  applyPlatformSettingOverride,
  getPlatformSetting,
  getPlatformSettingWithoutOverride,
  listPlatformSettings,
  parsePlatformSettingValue,
  publishPlatformSettingsChanged,
  validatePlatformSettingOverride
} from '../services/platform-settings.js';
import {
  PlatformSettingVersionConflictError,
  writePlatformSettingOverride
} from '../store/repository-platform-settings.js';
import { toSingleParam } from '../utils/params.js';
import {
  adminAuditEventInput,
  validationError
} from './admin-controller-common.js';

const platformSettingKeySchema = z.enum(PLATFORM_SETTING_KEYS);

function settingKey(req: AdminAuthenticatedRequest, res: Response): PlatformSettingKey | null {
  const parsed = platformSettingKeySchema.safeParse(toSingleParam(req.params.settingKey));
  if (!parsed.success) {
    validationError(res, 'Unknown platform setting');
    return null;
  }
  return parsed.data;
}

async function notifySettingChange(settingOverride: Awaited<ReturnType<typeof writePlatformSettingOverride>>): Promise<void> {
  applyPlatformSettingOverride(settingOverride);
  await publishPlatformSettingsChanged().catch((error) => {
    logger.warn({ error }, 'Failed publishing platform setting invalidation');
  });
}

export async function listSettings(
  _req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    res.status(200).json({ items: listPlatformSettings() });
  } catch (error) {
    next(error);
  }
}

export async function updateSetting(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const key = settingKey(req, res);
    if (!key) return;
    let value;
    try {
      value = parsePlatformSettingValue(key, req.body.value);
    } catch {
      validationError(res, 'Setting value does not match the required shape');
      return;
    }
    const policyError = validatePlatformSettingOverride(key, value);
    if (policyError) {
      validationError(res, policyError);
      return;
    }
    const before = getPlatformSetting(key);
    const stored = await writePlatformSettingOverride({
      key,
      overrideValue: value,
      expectedVersion: req.body.expectedVersion,
      updatedBy: req.admin.actor?.subject || req.admin.tokenId,
      auditEvent: adminAuditEventInput(req, {
        action: 'admin.system.setting.update',
        subjectType: 'platform_setting',
        subjectId: key,
        reason: req.body.reason,
        metadata: {
          settingKey: key,
          before: before.value,
          after: value,
          previousVersion: req.body.expectedVersion,
          version: req.body.expectedVersion + 1
        }
      })
    });
    await notifySettingChange(stored);
    res.status(200).json(getPlatformSetting(key));
  } catch (error) {
    if (error instanceof PlatformSettingVersionConflictError) {
      res.status(409).json({
        error: {
          code: 'VERSION_CONFLICT',
          message: error.message,
          retryable: false,
          details: { currentVersion: error.currentVersion }
        }
      });
      return;
    }
    next(error);
  }
}

export async function resetSetting(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const key = settingKey(req, res);
    if (!key) return;
    const before = getPlatformSetting(key);
    const after = getPlatformSettingWithoutOverride(key);
    const stored = await writePlatformSettingOverride({
      key,
      overrideValue: null,
      expectedVersion: req.body.expectedVersion,
      updatedBy: req.admin.actor?.subject || req.admin.tokenId,
      auditEvent: adminAuditEventInput(req, {
        action: 'admin.system.setting.reset',
        subjectType: 'platform_setting',
        subjectId: key,
        reason: req.body.reason,
        metadata: {
          settingKey: key,
          before: before.value,
          after: after.value,
          previousVersion: req.body.expectedVersion,
          version: req.body.expectedVersion + 1
        }
      })
    });
    await notifySettingChange(stored);
    res.status(200).json(getPlatformSetting(key));
  } catch (error) {
    if (error instanceof PlatformSettingVersionConflictError) {
      res.status(409).json({
        error: {
          code: 'VERSION_CONFLICT',
          message: error.message,
          retryable: false,
          details: { currentVersion: error.currentVersion }
        }
      });
      return;
    }
    next(error);
  }
}
