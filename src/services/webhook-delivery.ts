import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { webhookPrivateHostMatches } from '../config-webhook-egress.js';

const hardBlockedIpv4Addresses = new net.BlockList();
const hardBlockedIpv6Addresses = new net.BlockList();
const privateIpv4Addresses = new net.BlockList();
const privateIpv6Addresses = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  hardBlockedIpv4Addresses.addSubnet(address, prefix, 'ipv4');
}

privateIpv4Addresses.addSubnet('10.0.0.0', 8, 'ipv4');
privateIpv4Addresses.addSubnet('100.64.0.0', 10, 'ipv4');
privateIpv4Addresses.addSubnet('172.16.0.0', 12, 'ipv4');
privateIpv4Addresses.addSubnet('192.168.0.0', 16, 'ipv4');

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  hardBlockedIpv6Addresses.addSubnet(address, prefix, 'ipv6');
}

privateIpv6Addresses.addSubnet('fc00::', 7, 'ipv6');

const blockedHostnames = new Set(['localhost', 'metadata', 'metadata.google.internal']);

export interface WebhookDeliveryRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookDeliveryResponse {
  status: number;
  ok: boolean;
  retryAfter?: string;
}

interface ResolvedWebhookEndpoint {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export class WebhookDeliveryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryPolicyError';
  }
}

function isHardBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    blockedHostnames.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.metadata.google.internal')
  );
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized.endsWith('.local') || normalized.endsWith('.internal');
}

function urlHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)]$/, '$1');
}

function isHardBlockedAddress(address: string, family: 4 | 6): boolean {
  return family === 4
    ? hardBlockedIpv4Addresses.check(address, 'ipv4')
    : hardBlockedIpv6Addresses.check(address, 'ipv6');
}

function isPrivateAddress(address: string, family: 4 | 6): boolean {
  return family === 4
    ? privateIpv4Addresses.check(address, 'ipv4')
    : privateIpv6Addresses.check(address, 'ipv6');
}

export function validateWebhookDeliveryUrl(
  rawUrl: string,
  allowedPrivateHosts: readonly string[] = config.WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookDeliveryPolicyError('Webhook URL is invalid');
  }

  if (url.protocol !== 'https:') {
    throw new WebhookDeliveryPolicyError('Webhook URL must use https');
  }
  if (url.username || url.password) {
    throw new WebhookDeliveryPolicyError('Webhook URL must not include credentials');
  }
  const hostname = urlHostname(url);
  if (net.isIP(hostname) !== 0) {
    throw new WebhookDeliveryPolicyError('Webhook URL must use a DNS hostname');
  }
  if (isHardBlockedHostname(hostname)) {
    throw new WebhookDeliveryPolicyError('Webhook hostname is not allowed');
  }
  if (isPrivateHostname(hostname) && !webhookPrivateHostMatches(hostname, allowedPrivateHosts)) {
    throw new WebhookDeliveryPolicyError('Webhook private hostname is not allowed');
  }

  return url;
}

type WebhookDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: number }>>;

export async function resolveWebhookEndpoint(
  rawUrl: string,
  options: {
    allowedPrivateHosts?: readonly string[];
    lookup?: WebhookDnsLookup;
  } = {}
): Promise<ResolvedWebhookEndpoint> {
  const allowedPrivateHosts = options.allowedPrivateHosts ?? config.WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS;
  const url = validateWebhookDeliveryUrl(rawUrl, allowedPrivateHosts);
  const hostname = urlHostname(url);
  const lookup: WebhookDnsLookup = options.lookup ?? ((lookupHostname, lookupOptions) =>
    dns.lookup(lookupHostname, lookupOptions));
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new WebhookDeliveryPolicyError('Webhook hostname did not resolve');
  }

  for (const record of resolved) {
    if (record.family !== 4 && record.family !== 6) {
      throw new WebhookDeliveryPolicyError('Webhook hostname resolved to an unsupported address family');
    }
    const family = record.family === 4 ? 4 : 6;
    if (isHardBlockedAddress(record.address, family)) {
      throw new WebhookDeliveryPolicyError('Webhook hostname resolved to a blocked local or reserved address');
    }
    if (
      isPrivateAddress(record.address, family) &&
      !webhookPrivateHostMatches(hostname, allowedPrivateHosts)
    ) {
      throw new WebhookDeliveryPolicyError('Webhook hostname resolved to a blocked private address');
    }
  }

  const [record] = resolved;
  const family = record.family === 4 ? 4 : 6;
  return { url, hostname, address: record.address, family };
}

function createPinnedLookup(
  address: string,
  family: 4 | 6
): NonNullable<http.RequestOptions['lookup']> {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (!cb) {
      return;
    }
    if (typeof options === 'object' && options && 'all' in options && options.all) {
      (cb as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)(null, [
        { address, family }
      ]);
      return;
    }
    (cb as (err: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)(null, address, family);
  };
}

type WebhookEndpointResolver = (
  rawUrl: string
) => Promise<Awaited<ReturnType<typeof resolveWebhookEndpoint>>>;

function webhookTimeoutError(timeoutMs: number): Error {
  return new Error(`Webhook delivery timed out after ${timeoutMs}ms`);
}

async function resolveWithinDeliveryDeadline(
  request: WebhookDeliveryRequest,
  resolveEndpoint: WebhookEndpointResolver
): Promise<Awaited<ReturnType<typeof resolveWebhookEndpoint>>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(webhookTimeoutError(request.timeoutMs)), request.timeoutMs);
    resolveEndpoint(request.url).then(
      (endpoint) => {
        clearTimeout(timeout);
        resolve(endpoint);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function deliverWebhookRequest(
  request: WebhookDeliveryRequest,
  options: { resolveEndpoint?: WebhookEndpointResolver } = {}
): Promise<WebhookDeliveryResponse> {
  const startedAt = Date.now();
  const endpoint = await resolveWithinDeliveryDeadline(
    request,
    options.resolveEndpoint || resolveWebhookEndpoint
  );
  const remainingMs = request.timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw webhookTimeoutError(request.timeoutMs);
  const client = endpoint.url.protocol === 'https:' ? https : http;
  const lookup = createPinnedLookup(endpoint.address, endpoint.family);

  return await new Promise<WebhookDeliveryResponse>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (
      outcome: 'resolve' | 'reject',
      value: WebhookDeliveryResponse | Error
    ) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (outcome === 'resolve') resolve(value as WebhookDeliveryResponse);
      else reject(value);
    };
    const req = client.request(
      {
        protocol: endpoint.url.protocol,
        hostname: endpoint.hostname,
        port: endpoint.url.port || undefined,
        path: `${endpoint.url.pathname}${endpoint.url.search}`,
        method: request.method,
        headers: request.headers,
        lookup,
        servername: endpoint.hostname,
        timeout: remainingMs
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on('end', () => finish('resolve', {
          status,
          ok: status >= 200 && status < 300,
          retryAfter: typeof res.headers['retry-after'] === 'string' ? res.headers['retry-after'] : undefined
        }));
        res.on('error', (error) => finish('reject', error));
      }
    );

    req.on('timeout', () => {
      const error = webhookTimeoutError(request.timeoutMs);
      finish('reject', error);
      req.destroy(error);
    });
    req.on('error', (error) => finish('reject', error));
    deadline = setTimeout(() => {
      const error = webhookTimeoutError(request.timeoutMs);
      finish('reject', error);
      req.destroy(error);
    }, remainingMs);
    req.end(request.body);
  });
}

export const webhookDeliveryClient = {
  deliver: deliverWebhookRequest
};
