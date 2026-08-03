import { z } from 'zod';
import { DEFAULT_HELP_LINKS } from '../config-platform-settings.js';
import type { PlatformSettingOverride } from '../store/repository-platform-settings.js';
import type {
  PlatformSettingOverrideValueMap,
  PlatformSettingState
} from './platform-setting-types.js';

const maximumHelpLinkLength = 2048;

function validHttpsDestination(value: string): boolean {
  if (value.length > maximumHelpLinkLength) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validSupportDestination(value: string): boolean {
  if (validHttpsDestination(value)) return true;
  if (value.length > maximumHelpLinkLength || !value.startsWith('mailto:') || value.includes('?') || value.includes('#')) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.slice('mailto:'.length));
}

const helpLinksValueSchema = z.object({
  documentationUrl: z.string().trim().refine(validHttpsDestination),
  supportUrl: z.string().trim().refine(validSupportDestination)
}).strict();

export function parseHelpLinksValue(value: unknown): PlatformSettingOverrideValueMap['help_links'] {
  return helpLinksValueSchema.parse(value);
}

export function helpLinksState(entry?: PlatformSettingOverride): PlatformSettingState<'help_links'> {
  const productDefault = { ...DEFAULT_HELP_LINKS };
  const parsed = entry?.overrideValue === null || entry?.overrideValue === undefined
    ? undefined
    : helpLinksValueSchema.safeParse(entry.overrideValue);
  const overrideValue = parsed?.success ? parsed.data : undefined;
  const invalidOverride = Boolean(entry?.overrideValue !== null && entry?.overrideValue !== undefined && !overrideValue);
  return {
    key: 'help_links',
    value: overrideValue || productDefault,
    deploymentDefault: productDefault,
    ...(overrideValue ? { overrideValue } : {}),
    source: overrideValue
      ? 'runtime_override'
      : invalidOverride
        ? 'runtime_override_constrained'
        : 'deployment_default',
    version: entry?.version || 0,
    ...(entry?.updatedBy ? { updatedBy: entry.updatedBy } : {}),
    ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    editable: true,
    constraints: {
      documentationProtocols: ['https:'],
      supportProtocols: ['https:', 'mailto:'],
      maxUrlLength: maximumHelpLinkLength
    },
    ...(invalidOverride ? { warning: 'The stored help links are invalid, so the product defaults are in use.' } : {})
  };
}
