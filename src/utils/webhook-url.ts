import { config } from '../config.js';

export class WebhookUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlValidationError';
  }
}

function allowInsecureWebhookUrl(): boolean {
  return config.NODE_ENV !== 'production' && config.WEBHOOK_ALLOW_INSECURE_DEV_DELIVERY;
}

export function canonicalizeWebhookUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlValidationError('webhook URL must be a valid URL');
  }

  if (url.protocol !== 'https:' && !(allowInsecureWebhookUrl() && url.protocol === 'http:')) {
    throw new WebhookUrlValidationError('webhook URL must use https');
  }
  if (url.username || url.password) {
    throw new WebhookUrlValidationError('webhook URL must not include credentials');
  }

  return url.toString();
}

export function isValidWebhookUrl(rawUrl: string): boolean {
  try {
    canonicalizeWebhookUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
