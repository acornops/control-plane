import { randomBytes } from 'node:crypto';
import { config, type ExternalIntegrationClientDescriptor } from '../config.js';
import { repo } from '../store/repository.js';
import type { User } from '../types/domain.js';
import { hashToken } from '../utils/crypto.js';
import type { ExternalIntegrationUserLinkSummary } from '../store/repository-external-integration-links.js';

const INTEGRATION_LINK_TOKEN_PREFIX = 'intlink_';
const INTEGRATION_LINK_PATH = '/integrations/external/link';

export interface ExternalIntegrationIdentityInput {
  externalUserId: string;
  externalDisplayName?: string;
}

export interface ExternalIntegrationLinkToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface ExternalIntegrationLinkCreateResult {
  linkUrl: string;
  expiresAt: string;
}

function generateExternalIntegrationLinkToken(): string {
  return `${INTEGRATION_LINK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashExternalIntegrationLinkToken(token: string): string {
  return hashToken(token);
}

export function createConsoleExternalIntegrationLinkUrl(token: string): string {
  const base = new URL(config.MANAGEMENT_CONSOLE_BASE_URL);
  base.pathname = INTEGRATION_LINK_PATH;
  base.search = '';
  base.hash = '';
  base.searchParams.set('token', token);
  return base.toString();
}

export function createConsoleExternalIntegrationLinkStatusUrl(status: 'linked' | 'expired'): string {
  const base = new URL(config.MANAGEMENT_CONSOLE_BASE_URL);
  base.pathname = INTEGRATION_LINK_PATH;
  base.search = '';
  base.hash = '';
  base.searchParams.set('status', status);
  return base.toString();
}

export async function createExternalIntegrationLink(
  client: ExternalIntegrationClientDescriptor,
  input: ExternalIntegrationIdentityInput
): Promise<ExternalIntegrationLinkCreateResult> {
  const token = generateExternalIntegrationLinkToken();
  const expiresAt = new Date(Date.now() + config.EXTERNAL_INTEGRATION_LINK_TOKEN_TTL_SECONDS * 1000);
  await repo.createExternalIntegrationLinkToken({
    ...input,
    integrationClientId: client.id,
    provider: client.provider,
    clientDisplayName: client.displayName,
    tokenHash: hashExternalIntegrationLinkToken(token),
    expiresAt
  });
  return {
    linkUrl: createConsoleExternalIntegrationLinkUrl(token),
    expiresAt: expiresAt.toISOString()
  };
}

export async function completeExternalIntegrationLink(token: string, user: User): Promise<ExternalIntegrationUserLinkSummary | null> {
  return repo.completeExternalIntegrationLinkToken({
    tokenHash: hashExternalIntegrationLinkToken(token),
    acornopsUserId: user.id,
    linkExpiresAt: new Date(Date.now() + config.EXTERNAL_INTEGRATION_LINK_TTL_SECONDS * 1000)
  });
}
