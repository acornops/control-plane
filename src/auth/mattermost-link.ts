import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { repo } from '../store/repository.js';
import type { User } from '../types/domain.js';
import { hashToken } from '../utils/crypto.js';

const MATTERMOST_LINK_TOKEN_PREFIX = 'mmlink_';
const MATTERMOST_LINK_PATH = '/integrations/mattermost/link';

export interface MattermostIdentityInput {
  mattermostUserId: string;
}

export interface MattermostLinkToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface MattermostLinkCreateResult {
  linkUrl: string;
  expiresAt: string;
}

function generateMattermostLinkToken(): string {
  return `${MATTERMOST_LINK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashMattermostLinkToken(token: string): string {
  return hashToken(token);
}

export function createConsoleMattermostLinkUrl(token: string): string {
  const base = new URL(config.MANAGEMENT_CONSOLE_BASE_URL);
  base.pathname = MATTERMOST_LINK_PATH;
  base.search = '';
  base.hash = '';
  base.searchParams.set('token', token);
  return base.toString();
}

export function createConsoleMattermostLinkStatusUrl(status: 'linked' | 'expired'): string {
  const base = new URL(config.MANAGEMENT_CONSOLE_BASE_URL);
  base.pathname = MATTERMOST_LINK_PATH;
  base.search = '';
  base.hash = '';
  base.searchParams.set('status', status);
  return base.toString();
}

export async function createMattermostLink(input: MattermostIdentityInput): Promise<MattermostLinkCreateResult> {
  const token = generateMattermostLinkToken();
  const expiresAt = new Date(Date.now() + config.MATTERMOST_CHAT_LINK_TOKEN_TTL_SECONDS * 1000);
  await repo.createMattermostLinkToken({
    ...input,
    tokenHash: hashMattermostLinkToken(token),
    expiresAt
  });
  return {
    linkUrl: createConsoleMattermostLinkUrl(token),
    expiresAt: expiresAt.toISOString()
  };
}

export async function completeMattermostLink(token: string, user: User): Promise<boolean> {
  return repo.completeMattermostLinkToken({
    tokenHash: hashMattermostLinkToken(token),
    acornopsUserId: user.id,
    linkExpiresAt: new Date(Date.now() + config.MATTERMOST_CHAT_LINK_TTL_SECONDS * 1000)
  });
}
