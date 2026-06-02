import WebSocket from 'ws';

export interface DecodeAgentMessageOptions {
  allowCompression?: boolean;
  maxRawBytes?: number;
  maxDecodedBytes?: number;
}

export class AgentMessageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentMessageDecodeError';
  }
}

export function normalizeRawData(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (Array.isArray(raw)) {
    const chunks = raw.map((chunk) => Buffer.from(chunk as unknown as ArrayBufferLike));
    return Buffer.concat(chunks);
  }
  return Buffer.from(raw as unknown as ArrayBufferLike);
}

async function gunzipWithLimit(buffer: Buffer, maxDecodedBytes: number): Promise<Buffer> {
  const zlib = await import('node:zlib');
  return await new Promise<Buffer>((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxDecodedBytes) {
        gunzip.destroy(new AgentMessageDecodeError('Agent message exceeds decoded size limit'));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => resolve(Buffer.concat(chunks, total)));
    gunzip.on('error', reject);
    gunzip.end(buffer);
  });
}

export async function decodeAgentMessage(raw: WebSocket.RawData, options: DecodeAgentMessageOptions = {}): Promise<string> {
  const buffer = normalizeRawData(raw);
  if (options.maxRawBytes !== undefined && buffer.length > options.maxRawBytes) {
    throw new AgentMessageDecodeError('Agent message exceeds raw size limit');
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    if (!options.allowCompression) {
      throw new AgentMessageDecodeError('Compressed agent messages are not allowed before handshake');
    }
    const decoded = await gunzipWithLimit(buffer, options.maxDecodedBytes ?? Number.MAX_SAFE_INTEGER);
    return decoded.toString('utf-8');
  }
  if (options.maxDecodedBytes !== undefined && buffer.length > options.maxDecodedBytes) {
    throw new AgentMessageDecodeError('Agent message exceeds decoded size limit');
  }
  return buffer.toString('utf-8');
}
