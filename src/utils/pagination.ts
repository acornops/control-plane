import { toSingleParam } from './params.js';

export interface PagedResult<T> {
  items: T[];
  nextCursor?: string;
}

export interface PageRequest<TCursor extends Record<string, unknown> = Record<string, unknown>> {
  limit: number;
  cursor: TCursor | null;
  q: string;
  signature: string;
}

export class CursorMismatchError extends Error {
  constructor() {
    super('Cursor does not match the active query or filters');
  }
}

function normalizeFilterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFilterValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== '')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeFilterValue(entryValue)])
    );
  }
  return value;
}

export function normalizeSearchQuery(value: unknown): string {
  return toSingleParam(value as string | string[] | undefined).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function parseBoundedLimit(value: unknown, fallback = 50, max = 100): number {
  const raw = toSingleParam(value as string | string[] | undefined);
  if (!raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export function makeQuerySignature(parts: Record<string, unknown>): string {
  return JSON.stringify(normalizeFilterValue(parts));
}

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor<TCursor extends Record<string, unknown>>(
  cursor: unknown,
  expectedSignature: string
): TCursor | null {
  const raw = toSingleParam(cursor as string | string[] | undefined);
  if (!raw) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new CursorMismatchError();
  }
  if (decoded.signature !== expectedSignature) {
    throw new CursorMismatchError();
  }
  return decoded as TCursor;
}

export function pageWithCursor<T>(
  rows: T[],
  limit: number,
  makeCursor: (item: T) => string
): PagedResult<T> {
  const items = rows.slice(0, limit);
  const hasNext = rows.length > limit;
  const lastItem = items[items.length - 1];
  return {
    items,
    nextCursor: hasNext && lastItem ? makeCursor(lastItem) : undefined
  };
}

export function containsSearchText(fields: Array<unknown>, q: string): boolean {
  if (!q) return true;
  return fields.some((field) => String(field || '').toLowerCase().includes(q));
}

export function pageArray<T>(
  rows: T[],
  options: { limit: number; cursor: unknown; signature: string }
): PagedResult<T> {
  const decoded = decodeCursor<{ signature: string; offset: number }>(options.cursor, options.signature);
  const offset = Number.isInteger(decoded?.offset) && Number(decoded?.offset) >= 0 ? Number(decoded?.offset) : 0;
  const items = rows.slice(offset, offset + options.limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < rows.length
      ? encodeCursor({ signature: options.signature, offset: nextOffset })
      : undefined
  };
}
