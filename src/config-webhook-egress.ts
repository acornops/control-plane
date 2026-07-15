import net from 'node:net';
import { domainToASCII } from 'node:url';

const MAX_ALLOWED_PRIVATE_HOSTS = 100;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHostname(rawHostname: string): string {
  const trimmed = rawHostname.trim().toLowerCase().replace(/\.$/, '');
  const ascii = domainToASCII(trimmed);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.includes('/') ||
    ascii.includes(':') ||
    ascii.includes('@') ||
    net.isIP(ascii) !== 0
  ) {
    throw new Error(`Invalid webhook private hostname pattern: ${rawHostname}`);
  }
  const labels = ascii.split('.');
  if (labels.some((label) => !dnsLabelPattern.test(label))) {
    throw new Error(`Invalid webhook private hostname pattern: ${rawHostname}`);
  }
  return ascii;
}

export function normalizeWebhookPrivateHostPattern(rawPattern: string): string {
  const trimmed = rawPattern.trim();
  const wildcard = trimmed.startsWith('*.');
  const hostname = wildcard ? trimmed.slice(2) : trimmed;
  if (!hostname || hostname.includes('*')) {
    throw new Error(`Invalid webhook private hostname pattern: ${rawPattern}`);
  }
  const normalized = normalizeHostname(hostname);
  return wildcard ? `*.${normalized}` : normalized;
}

export function parseWebhookAllowedPrivateHostsJson(rawValue: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error('WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON must be a JSON array of hostname patterns');
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON must be a JSON array of hostname patterns');
  }
  if (parsed.length > MAX_ALLOWED_PRIVATE_HOSTS) {
    throw new Error(`WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON supports at most ${MAX_ALLOWED_PRIVATE_HOSTS} patterns`);
  }
  return [...new Set(parsed.map(normalizeWebhookPrivateHostPattern))];
}

export function webhookAllowedPrivateHostsJsonError(rawValue: string): string | undefined {
  try {
    parseWebhookAllowedPrivateHostsJson(rawValue);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid webhook private hostname configuration';
  }
}

export function webhookPrivateHostMatches(hostname: string, allowedPatterns: readonly string[]): boolean {
  let normalizedHostname: string;
  try {
    normalizedHostname = normalizeHostname(hostname);
  } catch {
    return false;
  }
  return allowedPatterns.some((pattern) => {
    if (!pattern.startsWith('*.')) {
      return normalizedHostname === pattern;
    }
    const suffix = pattern.slice(1);
    return normalizedHostname.endsWith(suffix) && normalizedHostname.length > suffix.length;
  });
}
