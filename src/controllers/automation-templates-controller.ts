import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import {
  activateAutomationTemplate,
  getInstalledAutomationTemplate,
  getAutomationTemplateInstallations,
  installAutomationTemplate,
  listAutomationTemplateBundles
} from '../services/automation-template-lifecycle.js';
import { toSingleParam } from '../utils/params.js';
import { incrementAutomationTemplateSetup } from '../metrics.js';

export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json({
      templates: await listAutomationTemplateBundles(workspaceId),
      installations: await getAutomationTemplateInstallations(workspaceId)
    });
  } catch (error) { next(error); }
}

async function requireTemplateManagement(req: AuthenticatedRequest, res: Response, requireMcp = false) {
  const workspaceId = toSingleParam(req.params.workspaceId);
  const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_workflows', 'Template setup requires manage_workflows.');
  if (!authz) return null;
  if (!authz.can('manage_agents') || (requireMcp && !authz.can('manage_mcp'))) {
    res.status(403).json({ error: {
      code: 'FORBIDDEN',
      message: requireMcp
        ? 'Source-control setup requires manage_workflows, manage_agents, and manage_mcp.'
        : 'Template installation requires manage_workflows and manage_agents.',
      retryable: false
    } });
    return null;
  }
  return { workspaceId, authz };
}

function templateError(res: Response, error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  if (code === 'AUTOMATION_TEMPLATE_NOT_FOUND' || code === 'AUTOMATION_TEMPLATE_NOT_INSTALLED') {
    res.status(404).json({ error: { code, message: 'Automation template not found or not installed.', retryable: false } });
    return true;
  }
  if (code === 'AUTOMATION_TEMPLATE_PREREQUISITES_UNAVAILABLE') {
    res.status(409).json({ error: { code, message: 'Complete and review the workspace prerequisites before activation.', retryable: false } });
    return true;
  }
  return false;
}

export async function install(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await requireTemplateManagement(req, res);
    if (!context) return;
    const result = await installAutomationTemplate({
      workspaceId: context.workspaceId,
      templateId: toSingleParam(req.params.templateId),
      installedBy: req.auth.userId
    });
    incrementAutomationTemplateSetup('install', 'success');
    res.status(result.alreadyInstalled ? 200 : 201).json(result);
  } catch (error) { incrementAutomationTemplateSetup('install', 'failure'); if (!templateError(res, error)) next(error); }
}

export async function activate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await requireTemplateManagement(req, res);
    if (!context) return;
    const result = await activateAutomationTemplate({
      workspaceId: context.workspaceId,
      templateId: toSingleParam(req.params.templateId),
      activatedBy: req.auth.userId
    });
    incrementAutomationTemplateSetup('activate', 'success');
    res.status(200).json(result);
  } catch (error) { incrementAutomationTemplateSetup('activate', 'failure'); if (!templateError(res, error)) next(error); }
}
