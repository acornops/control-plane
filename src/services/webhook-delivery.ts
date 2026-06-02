import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const blockedAddresses = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

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

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    blockedHostnames.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  );
}

function urlHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)]$/, '$1');
}

function isBlockedAddress(address: string, family: 4 | 6): boolean {
  return blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function validateWebhookDeliveryUrl(rawUrl: string): URL {
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
  if (isBlockedHostname(urlHostname(url))) {
    throw new WebhookDeliveryPolicyError('Webhook hostname is not allowed');
  }

  return url;
}

export async function resolveWebhookEndpoint(rawUrl: string): Promise<ResolvedWebhookEndpoint> {
  const url = validateWebhookDeliveryUrl(rawUrl);
  const hostname = urlHostname(url);
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new WebhookDeliveryPolicyError('Webhook hostname did not resolve');
  }

  for (const record of resolved) {
    if (record.family !== 4 && record.family !== 6) {
      throw new WebhookDeliveryPolicyError('Webhook hostname resolved to an unsupported address family');
    }
    const family = record.family === 4 ? 4 : 6;
    if (isBlockedAddress(record.address, family)) {
      throw new WebhookDeliveryPolicyError('Webhook hostname resolved to a blocked address');
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

async function deliverWebhookRequest(request: WebhookDeliveryRequest): Promise<WebhookDeliveryResponse> {
  const endpoint = await resolveWebhookEndpoint(request.url);
  const client = endpoint.url.protocol === 'https:' ? https : http;
  const lookup = createPinnedLookup(endpoint.address, endpoint.family);

  return await new Promise<WebhookDeliveryResponse>((resolve, reject) => {
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
        timeout: request.timeoutMs
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on('end', () => resolve({ status, ok: status >= 200 && status < 300 }));
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Webhook delivery timed out after ${request.timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end(request.body);
  });
}

export const webhookDeliveryClient = {
  deliver: deliverWebhookRequest
};
