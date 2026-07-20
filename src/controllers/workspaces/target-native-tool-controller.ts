import { NextFunction, Response } from 'express';
import { listConfiguredRoleTemplates } from '../../auth/authorization.js';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { config } from '../../config.js';
import {
  defaultModel,
  defaultProvider,
  isModelAllowedForProvider,
  parseAllowedModels,
  parseAllowedProviderModels,
  parseAllowedProviders
} from '../../services/llm-policy.js';
import { TARGET_INSIGHTS_TOOL_ID, normalizeTargetInsightsConfig } from '../../services/target-insights/config.js';
import { recordTargetInsightsAudit } from '../../services/target-insights/audit.js';
import { requeuePausedTargetInsightsCheckpoints } from '../../services/target-insights/requeue.js';
import { targetWebhookScope } from '../../services/target-webhook-scope.js';
import { webhooks } from '../../services/webhooks.js';
import {
  getWorkspaceNativeTool,
  listWorkspaceNativeToolsForInvocationScope,
  NativeToolAuthorizationClass
} from '../../services/workspace-native-tools.js';
import { repo } from '../../store/repository.js';
import { TargetType } from '../../types/domain.js';
import { TargetInsightsToolConfig } from '../../types/target-insights.js';
import { toSingleParam } from '../../utils/params.js';
import { recordNativeToolSettingAudit } from './mcp-audit.js';

const WEB_SEARCH_TOOL_ID = 'web_search';

interface DomainFiltersConfig extends Record<string, unknown> {
  domainFilters: {
    allowedDomains: string[];
    blockedDomains: string[];
  };
}

interface PlatformNativeToolConfig extends Record<string, unknown> {
  authorizationClass: NativeToolAuthorizationClass;
}

interface TargetNativeToolItem {
  id: string;
  label: string;
  enabled: boolean;
  toggleable: boolean;
  description: string;
  origin: 'target_setting' | 'platform_native';
  capability: 'read' | 'write';
  runtimeKind: 'provider_native' | 'function';
  visibility: {
    appearsInAssistantToolList: boolean;
    appearsInRunEnabledTools: boolean;
    appearsInToolCalls: boolean;
  };
  config: DomainFiltersConfig | TargetInsightsToolConfig | PlatformNativeToolConfig;
  readiness?: {
    learningAvailable: boolean;
    learningPausedReason: 'ai_settings_missing' | 'provider_not_allowed' | 'model_not_allowed' | null;
  };
  permissions?: {
    canEdit: boolean;
  };
}

type TargetInsightsReadiness = NonNullable<TargetNativeToolItem['readiness']>;

function getNativeToolEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_tools'))
    .map((role) => role.key);
}

function getTargetInsightsEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_target_insights'))
    .map((role) => role.key);
}

function defaultWebSearchConfig(): DomainFiltersConfig {
  return {
    domainFilters: {
      allowedDomains: [],
      blockedDomains: []
    }
  };
}

function normalizePersistedWebSearchConfig(config: Record<string, unknown> | undefined): DomainFiltersConfig {
  const domainFilters = config?.domainFilters;
  if (!domainFilters || typeof domainFilters !== 'object' || Array.isArray(domainFilters)) {
    return defaultWebSearchConfig();
  }
  const filters = domainFilters as Record<string, unknown>;
  return {
    domainFilters: {
      allowedDomains: Array.isArray(filters.allowedDomains)
        ? filters.allowedDomains.filter((value): value is string => typeof value === 'string')
        : [],
      blockedDomains: Array.isArray(filters.blockedDomains)
        ? filters.blockedDomains.filter((value): value is string => typeof value === 'string')
        : []
    }
  };
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('Domain cannot be empty');
  }
  if (
    trimmed.includes('://') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes(':') ||
    trimmed.includes('*') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new Error(`Domain "${value}" must be a hostname without scheme, path, port, or wildcard`);
  }
  if (trimmed.length > 253) {
    throw new Error(`Domain "${value}" is too long`);
  }
  const labels = trimmed.split('.');
  if (labels.length < 2 || labels.some((label) => !label)) {
    throw new Error(`Domain "${value}" must be a fully qualified hostname`);
  }
  for (const label of labels) {
    if (label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error(`Domain "${value}" is not a valid hostname`);
    }
  }
  return trimmed;
}

function normalizeDomainList(values: unknown, label: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  const seen = new Set<string>();
  return values.map((value) => {
    if (typeof value !== 'string') {
      throw new Error(`${label} must contain only strings`);
    }
    const normalized = normalizeDomain(value);
    if (seen.has(normalized)) {
      throw new Error(`${label} contains duplicate domain "${normalized}"`);
    }
    seen.add(normalized);
    return normalized;
  });
}

function normalizeWebSearchConfig(input: unknown): DomainFiltersConfig {
  if (input === undefined || input === null) {
    return defaultWebSearchConfig();
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be an object');
  }
  const domainFilters = (input as Record<string, unknown>).domainFilters;
  if (domainFilters === undefined) {
    return defaultWebSearchConfig();
  }
  if (typeof domainFilters !== 'object' || domainFilters === null || Array.isArray(domainFilters)) {
    throw new Error('domainFilters must be an object');
  }
  const filters = domainFilters as Record<string, unknown>;
  const allowedDomains = normalizeDomainList(filters.allowedDomains, 'allowedDomains');
  const blockedDomains = normalizeDomainList(filters.blockedDomains, 'blockedDomains');
  const blocked = new Set(blockedDomains);
  const overlap = allowedDomains.find((domain) => blocked.has(domain));
  if (overlap) {
    throw new Error(`Domain "${overlap}" cannot be both allowed and blocked`);
  }
  return {
    domainFilters: {
      allowedDomains,
      blockedDomains
    }
  };
}

function buildWebSearchItem(
  setting: { enabled: boolean; config: Record<string, unknown> } | null | undefined,
  canEdit: boolean
): TargetNativeToolItem {
  return {
    id: WEB_SEARCH_TOOL_ID,
    label: 'Web Search',
    enabled: setting?.enabled ?? true,
    toggleable: true,
    description: 'Allow assistant runs for this target to search the web through the selected LLM provider.',
    origin: 'target_setting',
    capability: 'read',
    runtimeKind: 'provider_native',
    visibility: {
      appearsInAssistantToolList: true,
      appearsInRunEnabledTools: true,
      appearsInToolCalls: false
    },
    config: normalizePersistedWebSearchConfig(setting?.config),
    permissions: {
      canEdit
    }
  };
}

function buildTargetInsightsItem(
  setting: { enabled: boolean; config: Record<string, unknown> } | null | undefined,
  readiness: TargetInsightsReadiness,
  canEdit: boolean
): TargetNativeToolItem {
  return {
    id: TARGET_INSIGHTS_TOOL_ID,
    label: 'Insights',
    enabled: setting?.enabled ?? true,
    toggleable: true,
    description: 'Retrieve and improve target-specific troubleshooting insights for future assistant runs.',
    origin: 'target_setting',
    capability: 'read',
    runtimeKind: 'function',
    visibility: {
      appearsInAssistantToolList: true,
      appearsInRunEnabledTools: true,
      appearsInToolCalls: false
    },
    config: normalizeTargetInsightsConfig(setting?.config),
    readiness,
    permissions: {
      canEdit
    }
  };
}

export function buildPlatformNativeTargetToolItems(
  settingsByToolId: ReadonlyMap<string, { enabled: boolean }> = new Map(),
  canEdit = false
): TargetNativeToolItem[] {
  return listWorkspaceNativeToolsForInvocationScope('target_chat').map((tool) => ({
    id: tool.id,
    label: tool.title,
    enabled: settingsByToolId.get(tool.id)?.enabled ?? true,
    toggleable: tool.targetToggleable === true,
    description: tool.targetCatalogDescription || tool.description,
    origin: 'platform_native',
    capability: tool.approvalOperation,
    runtimeKind: 'function',
    visibility: {
      appearsInAssistantToolList: true,
      appearsInRunEnabledTools: true,
      appearsInToolCalls: true
    },
    config: {
      authorizationClass: tool.authorizationClass
    },
    permissions: {
      canEdit: tool.targetToggleable === true && canEdit
    }
  }));
}

function respondMissingToolsCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with tool management capability can modify tool settings',
      retryable: false
    }
  });
}

function respondMissingTargetInsightsCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with target insights management capability can modify Target Insights settings',
      retryable: false
    }
  });
}

async function resolveTargetInsightsReadiness(workspaceId: string, toolConfig: TargetInsightsToolConfig): Promise<TargetInsightsReadiness> {
  const workspaceAiSettings = await repo.getWorkspaceAiSettings(workspaceId);
  const provider = toolConfig.learning.checkpointModel.mode === 'custom'
    ? toolConfig.learning.checkpointModel.provider
    : workspaceAiSettings?.defaultProvider || defaultProvider();
  const model = toolConfig.learning.checkpointModel.mode === 'custom'
    ? toolConfig.learning.checkpointModel.model
    : workspaceAiSettings?.defaultModel || defaultModel();
  const allowedProviders = parseAllowedProviders();
  const allowedModels = parseAllowedModels();
  const allowedProviderModels = parseAllowedProviderModels();
  if (!provider || !allowedProviders.includes(provider)) {
    return { learningAvailable: false, learningPausedReason: 'provider_not_allowed' };
  }
  if (!model || !allowedModels.includes(model) || !isModelAllowedForProvider(provider, model, allowedProviderModels)) {
    return { learningAvailable: false, learningPausedReason: 'model_not_allowed' };
  }
  return { learningAvailable: true, learningPausedReason: null };
}

async function validateTargetInsightsToolConfig(workspaceId: string, toolConfig: TargetInsightsToolConfig): Promise<string | null> {
  if (toolConfig.learning.checkpointModel.mode !== 'custom') {
    return null;
  }
  const readiness = await resolveTargetInsightsReadiness(workspaceId, toolConfig);
  if (readiness.learningAvailable) {
    return null;
  }
  if (readiness.learningPausedReason === 'provider_not_allowed') {
    return 'Selected checkpoint model provider is not allowed';
  }
  return 'Selected checkpoint model is not allowed for this deployment';
}

export async function listTargetTools(
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
    const targetChatNativeTools = listWorkspaceNativeToolsForInvocationScope('target_chat');
    const [webSearchSetting, targetInsightsSetting, platformNativeSettings] = await Promise.all([
      repo.getTargetToolSetting(targetId, WEB_SEARCH_TOOL_ID),
      config.TARGET_INSIGHTS_ENABLED ? repo.getTargetToolSetting(targetId, TARGET_INSIGHTS_TOOL_ID) : Promise.resolve(null),
      Promise.all(targetChatNativeTools
        .filter((tool) => tool.targetToggleable)
        .map(async (tool) => [tool.id, await repo.getTargetToolSetting(targetId, tool.id)] as const))
    ]);
    const insightsConfig = normalizeTargetInsightsConfig(targetInsightsSetting?.config);
    const items: TargetNativeToolItem[] = [buildWebSearchItem(webSearchSetting, access.authz.can('manage_tools'))];
    if (config.TARGET_INSIGHTS_ENABLED) {
      const insightsReadiness = await resolveTargetInsightsReadiness(workspaceId, insightsConfig);
      items.push(buildTargetInsightsItem(targetInsightsSetting, insightsReadiness, access.authz.can('manage_target_insights')));
    }
    const platformNativeSettingsByToolId = new Map(
      platformNativeSettings.flatMap(([toolId, setting]) => setting ? [[toolId, setting] as const] : [])
    );
    items.push(...buildPlatformNativeTargetToolItems(platformNativeSettingsByToolId, access.authz.can('manage_tools')));
    res.status(200).json({
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      permissions: {
        canEdit: access.authz.can('manage_tools') || access.authz.can('manage_target_insights'),
        editableRoles: [...new Set([...getNativeToolEditableRoles(), ...getTargetInsightsEditableRoles()])]
      },
      items
    });
  } catch (err) {
    next(err);
  }
}

export async function updateTargetToolSettings(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const toolId = toSingleParam(req.params.toolId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    const platformNativeTool = getWorkspaceNativeTool(toolId);
    const isToggleablePlatformNativeTool = Boolean(
      platformNativeTool?.invocationScopes.includes('target_chat') && platformNativeTool.targetToggleable
    );
    if (toolId !== WEB_SEARCH_TOOL_ID && toolId !== TARGET_INSIGHTS_TOOL_ID && !isToggleablePlatformNativeTool) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found', retryable: false } });
      return;
    }
    if (toolId === TARGET_INSIGHTS_TOOL_ID && !config.TARGET_INSIGHTS_ENABLED) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found', retryable: false } });
      return;
    }
    if (isToggleablePlatformNativeTool && !access.authz.can('manage_tools')) {
      respondMissingToolsCapability(res);
      return;
    }
    if (toolId === WEB_SEARCH_TOOL_ID && !access.authz.can('manage_tools')) {
      respondMissingToolsCapability(res);
      return;
    }
    if (toolId === TARGET_INSIGHTS_TOOL_ID && !access.authz.can('manage_target_insights')) {
      respondMissingTargetInsightsCapability(res);
      return;
    }
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'enabled is required', retryable: false } });
      return;
    }

    if (isToggleablePlatformNativeTool && platformNativeTool) {
      const toolConfig: PlatformNativeToolConfig = {
        authorizationClass: platformNativeTool.authorizationClass
      };
      const setting = await repo.upsertTargetToolSetting(targetId, toolId, req.body.enabled, toolConfig);
      webhooks.emit({
        type: 'tool.catalog.changed.v1',
        workspaceId,
        ...targetWebhookScope(targetId, access.target.targetType),
        subject: { type: 'target', id: targetId },
        data: { reason: 'target_tool_setting_updated', toolId, enabled: req.body.enabled }
      });
      await recordNativeToolSettingAudit(
        workspaceId,
        targetId,
        access.target.targetType,
        req.auth.userId,
        toolId,
        req.body.enabled,
        toolConfig
      );
      const updated = buildPlatformNativeTargetToolItems(
        new Map([[toolId, setting]]),
        true
      ).find((tool) => tool.id === toolId);
      res.status(200).json(updated);
      return;
    }

    const existingSetting = await repo.getTargetToolSetting(targetId, toolId);
    let toolConfig: DomainFiltersConfig | TargetInsightsToolConfig;
    try {
      if (toolId === WEB_SEARCH_TOOL_ID) {
        toolConfig = Object.prototype.hasOwnProperty.call(req.body, 'config')
          ? normalizeWebSearchConfig(req.body?.config)
          : normalizePersistedWebSearchConfig(existingSetting?.config);
      } else {
        toolConfig = normalizeTargetInsightsConfig(
          Object.prototype.hasOwnProperty.call(req.body, 'config')
            ? req.body?.config
            : existingSetting?.config
        );
      }
    } catch (err) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err instanceof Error ? err.message : 'Invalid tool config',
          retryable: false
        }
      });
      return;
    }
    if (toolId === TARGET_INSIGHTS_TOOL_ID) {
      const validationMessage = await validateTargetInsightsToolConfig(workspaceId, toolConfig as TargetInsightsToolConfig);
      if (validationMessage) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: validationMessage,
            retryable: false
          }
        });
        return;
      }
    }

    const setting = await repo.upsertTargetToolSetting(targetId, toolId, req.body.enabled, toolConfig as unknown as Record<string, unknown>);
    webhooks.emit({
      type: 'tool.catalog.changed.v1',
      workspaceId,
      ...targetWebhookScope(targetId, access.target.targetType),
      subject: { type: 'target', id: targetId },
      data: {
        reason: 'target_tool_setting_updated',
        toolId,
        enabled: req.body.enabled
      }
    });
    if (toolId === WEB_SEARCH_TOOL_ID) {
      await recordNativeToolSettingAudit(
        workspaceId,
        targetId,
        access.target.targetType,
        req.auth.userId,
        toolId,
        req.body.enabled,
        toolConfig as DomainFiltersConfig
      );
      res.status(200).json(buildWebSearchItem(setting, access.authz.can('manage_tools')));
      return;
    }

    const readiness = await resolveTargetInsightsReadiness(workspaceId, toolConfig as TargetInsightsToolConfig);
    await requeuePausedTargetInsightsCheckpoints({
      workspaceId,
      targetId,
      reason: 'target_insights_tool_setting_updated'
    });
    await recordTargetInsightsAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'target_insights.tool.setting_updated.v1',
      objectId: targetId,
      summary: 'Target Insights setting changed',
      metadata: { enabled: req.body.enabled, config: toolConfig }
    });
    res.status(200).json(buildTargetInsightsItem(setting, readiness, access.authz.can('manage_target_insights')));
  } catch (err) {
    next(err);
  }
}
