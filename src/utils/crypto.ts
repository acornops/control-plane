import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(secret: string, encoded: string): boolean {
  const [saltHex, hashHex] = encoded.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(secret, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function generateAgentKey(clusterId?: string): string {
  const token = randomBytes(24).toString('base64url');
  if (clusterId) {
    return `ak_${clusterId}_${token}`;
  }
  return `ak_${token}`;
}

export function extractClusterIdFromAgentKey(agentKey: string): string | null {
  const match = /^ak_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_/i.exec(agentKey);
  return match?.[1] || null;
}

export function generateWorkspaceInviteToken(): string {
  return `wi_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateWebhookSecret(): string {
  const token = randomBytes(32).toString('base64url');
  return `whsec_${token}`;
}

function getWebhookEncryptionKey(): Buffer {
  if (config.WEBHOOK_SECRET_ENCRYPTION_KEY) {
    const key = Buffer.from(config.WEBHOOK_SECRET_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) {
      throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return key;
  }

  if (config.NODE_ENV === 'production') {
    throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY is required in production');
  }

  return createHmac('sha256', 'acornops-local-webhook-secret-key')
    .update('development')
    .digest();
}

export function encryptWebhookSecret(secret: string): string {
  const key = getWebhookEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptWebhookSecret(encoded: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = encoded.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Invalid webhook secret ciphertext');
  }
  const decipher = createDecipheriv('aes-256-gcm', getWebhookEncryptionKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64url')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}
