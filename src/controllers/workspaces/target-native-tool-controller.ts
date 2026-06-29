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
import { KNOWLEDGE_BANK_TOOL_ID, normalizeKnowledgeBankConfig } from '../../services/knowledge-bank/config.js';
import { recordKnowledgeBankAudit } from '../../services/knowledge-bank/audit.js';
import { requeuePausedKnowledgeBankCheckpoints } from '../../services/knowledge-bank/requeue.js';
import { webhooks } from '../../services/webhooks.js';
import { repo } from '../../store/repository.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../../types/domain.js';
import { KnowledgeBankToolConfig } from '../../types/knowledge-bank.js';
import { toSingleParam } from '../../utils/params.js';
import { recordNativeToolSettingAudit } from './mcp-audit.js';

const WEB_SEARCH_TOOL_ID = 'web_search';

interface DomainFiltersConfig extends Record<string, unknown> {
  domainFilters: {
    allowedDomains: string[];
    blockedDomains: string[];
  };
}

interface TargetNativeToolItem {
  id: typeof WEB_SEARCH_TOOL_ID | typeof KNOWLEDGE_BANK_TOOL_ID;
  label: string;
  enabled: boolean;
  description: string;
  capability: 'read' | 'write';
  runtimeKind: 'provider_native' | 'function';
  visibility: {
    appearsInAssistantToolList: boolean;
    appearsInRunEnabledTools: boolean;
    appearsInToolCalls: boolean;
  };
  config: DomainFiltersConfig | KnowledgeBankToolConfig;
  readiness?: {
    learningAvailable: boolean;
    learningPausedReason: 'ai_settings_missing' | 'provider_not_allowed' | 'model_not_allowed' | null;
  };
  permissions?: {
    canEdit: boolean;
  };
}

type KnowledgeBankReadiness = NonNullable<TargetNativeToolItem['readiness']>;

function getNativeToolEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_tools'))
    .map((role) => role.key);
}

function getKnowledgeBankEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_knowledge_bank'))
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
    description: 'Allow assistant runs for this target to search the web through the selected LLM provider.',
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

function buildKnowledgeBankItem(
  setting: { enabled: boolean; config: Record<string, unknown> } | null | undefined,
  readiness: KnowledgeBankReadiness,
  canEdit: boolean
): TargetNativeToolItem {
  return {
    id: KNOWLEDGE_BANK_TOOL_ID,
    label: 'Knowledge Bank',
    enabled: setting?.enabled ?? true,
    description: 'Retrieve and improve target-specific troubleshooting knowledge for future assistant runs.',
    capability: 'read',
    runtimeKind: 'function',
    visibility: {
      appearsInAssistantToolList: true,
      appearsInRunEnabledTools: true,
      appearsInToolCalls: false
    },
    config: normalizeKnowledgeBankConfig(setting?.config),
    readiness,
    permissions: {
      canEdit
    }
  };
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

function respondMissingKnowledgeBankCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with knowledge bank management capability can modify Knowledge Bank settings',
      retryable: false
    }
  });
}

async function resolveKnowledgeBankReadiness(workspaceId: string, toolConfig: KnowledgeBankToolConfig): Promise<KnowledgeBankReadiness> {
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

async function validateKnowledgeBankToolConfig(workspaceId: string, toolConfig: KnowledgeBankToolConfig): Promise<string | null> {
  if (toolConfig.learning.checkpointModel.mode !== 'custom') {
    return null;
  }
  const readiness = await resolveKnowledgeBankReadiness(workspaceId, toolConfig);
  if (readiness.learningAvailable) {
    return null;
  }
  if (readiness.learningPausedReason === 'provider_not_allowed') {
    return 'Selected checkpoint model provider is not allowed';
  }
  return 'Selected checkpoint model is not allowed for this deployment';
}

function targetWebhookScope(targetId: string, targetType: TargetType): {
  clusterId?: string;
  targetId: string;
  targetType: TargetType;
} {
  return {
    ...(targetType === KUBERNETES_TARGET_TYPE ? { clusterId: targetId } : {}),
    targetId,
    targetType
  };
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
    const [webSearchSetting, knowledgeBankSetting] = await Promise.all([
      repo.getTargetToolSetting(targetId, WEB_SEARCH_TOOL_ID),
      config.KNOWLEDGE_BANK_ENABLED ? repo.getTargetToolSetting(targetId, KNOWLEDGE_BANK_TOOL_ID) : Promise.resolve(null)
    ]);
    const knowledgeConfig = normalizeKnowledgeBankConfig(knowledgeBankSetting?.config);
    const items: TargetNativeToolItem[] = [buildWebSearchItem(webSearchSetting, access.authz.can('manage_tools'))];
    if (config.KNOWLEDGE_BANK_ENABLED) {
      const knowledgeReadiness = await resolveKnowledgeBankReadiness(workspaceId, knowledgeConfig);
      items.push(buildKnowledgeBankItem(knowledgeBankSetting, knowledgeReadiness, access.authz.can('manage_knowledge_bank')));
    }
    res.status(200).json({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      ...(access.target.targetType === KUBERNETES_TARGET_TYPE ? { clusterId: targetId } : {}),
      permissions: {
        canEdit: access.authz.can('manage_tools') || access.authz.can('manage_knowledge_bank'),
        editableRoles: [...new Set([...getNativeToolEditableRoles(), ...getKnowledgeBankEditableRoles()])]
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
    if (toolId !== WEB_SEARCH_TOOL_ID && toolId !== KNOWLEDGE_BANK_TOOL_ID) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found', retryable: false } });
      return;
    }
    if (toolId === KNOWLEDGE_BANK_TOOL_ID && !config.KNOWLEDGE_BANK_ENABLED) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found', retryable: false } });
      return;
    }
    if (toolId === WEB_SEARCH_TOOL_ID && !access.authz.can('manage_tools')) {
      respondMissingToolsCapability(res);
      return;
    }
    if (toolId === KNOWLEDGE_BANK_TOOL_ID && !access.authz.can('manage_knowledge_bank')) {
      respondMissingKnowledgeBankCapability(res);
      return;
    }
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'enabled is required', retryable: false } });
      return;
    }

    const existingSetting = await repo.getTargetToolSetting(targetId, toolId);
    let toolConfig: DomainFiltersConfig | KnowledgeBankToolConfig;
    try {
      if (toolId === WEB_SEARCH_TOOL_ID) {
        toolConfig = Object.prototype.hasOwnProperty.call(req.body, 'config')
          ? normalizeWebSearchConfig(req.body?.config)
          : normalizePersistedWebSearchConfig(existingSetting?.config);
      } else {
        toolConfig = normalizeKnowledgeBankConfig(
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
    if (toolId === KNOWLEDGE_BANK_TOOL_ID) {
      const validationMessage = await validateKnowledgeBankToolConfig(workspaceId, toolConfig as KnowledgeBankToolConfig);
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

    const readiness = await resolveKnowledgeBankReadiness(workspaceId, toolConfig as KnowledgeBankToolConfig);
    await requeuePausedKnowledgeBankCheckpoints({
      workspaceId,
      targetId,
      reason: 'knowledge_bank_tool_setting_updated'
    });
    await recordKnowledgeBankAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'knowledge.tool.setting_updated.v1',
      objectId: targetId,
      summary: 'Knowledge Bank setting changed',
      metadata: { enabled: req.body.enabled, config: toolConfig }
    });
    res.status(200).json(buildKnowledgeBankItem(setting, readiness, access.authz.can('manage_knowledge_bank')));
  } catch (err) {
    next(err);
  }
}
