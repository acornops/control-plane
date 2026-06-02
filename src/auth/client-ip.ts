import { Request } from 'express';

export function requestIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
