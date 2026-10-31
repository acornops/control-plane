import { z } from 'zod';
import { parseVirtualMachinePlatform } from '../types/virtual-machine-platform.js';

const windowsLogInput = z.object({
  channel: z.enum(['Application', 'System']), since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(), query: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(500), byte_limit: z.number().int().min(1024).max(1048576)
}).strict();

export function buildVirtualMachineLogRequest(
  metadata: Record<string, unknown>, input: Record<string, unknown>, limit: number, byteLimit: number
): { arguments: Record<string, unknown>; source?: string; unit?: string; channel?: string; query?: string } {
  const platform = parseVirtualMachinePlatform(metadata);
  if (!platform) throw new Error('Stored VM platform is invalid');
  const query = typeof input.q === 'string' ? input.q : undefined;
  if (platform.osFamily === 'windows') {
    if (input.unit !== undefined || input.source !== undefined) throw new Error('Windows logs require channel=Application or System');
    const parsed = windowsLogInput.safeParse({ channel: input.channel, since: input.since, until: input.until, query, limit, byte_limit: byteLimit });
    if (!parsed.success) throw new Error('Windows logs require a native channel, bounded literal query and ISO timestamps');
    return { arguments: parsed.data, source: 'windows_event_log', channel: parsed.data.channel, query };
  }
  const source = typeof input.source === 'string' ? input.source : undefined;
  if (source && source !== 'journald') throw new Error('VM logs support only source=journald');
  const unit = typeof input.unit === 'string' ? input.unit : undefined;
  return { arguments: { unit, query, limit, byte_limit: byteLimit }, source, unit, query };
}
