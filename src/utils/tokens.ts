import { createHash, timingSafeEqual } from 'node:crypto';

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function constantTimeEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(tokenDigest(candidate), tokenDigest(expected));
}
