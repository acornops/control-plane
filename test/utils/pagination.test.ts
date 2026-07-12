import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  containsSearchText,
  CursorMismatchError,
  decodeCursor,
  encodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  pageWithCursor,
  parseBoundedLimit
} from '../../src/utils/pagination.js';

describe('pagination helpers', () => {
  it('normalizes search queries from strings and repeated params', () => {
    assert.equal(normalizeSearchQuery('  Mixed   CASE   Query  '), 'mixed case query');
    assert.equal(normalizeSearchQuery(['  First Value  ', 'ignored']), 'first value');
  });

  it('bounds page limits with sane defaults', () => {
    assert.equal(parseBoundedLimit(undefined), 50);
    assert.equal(parseBoundedLimit('not-a-number'), 50);
    assert.equal(parseBoundedLimit('7.9'), 7);
    assert.equal(parseBoundedLimit('0'), 1);
    assert.equal(parseBoundedLimit('999', 50, 100), 100);
  });

  it('builds stable query signatures for logically equivalent filters', () => {
    const left = makeQuerySignature({
      q: 'demo',
      filters: {
        workspaceId: 'ws-1',
        role: 'admin',
        includeArchived: false,
        empty: '',
        nullable: null
      }
    });
    const right = makeQuerySignature({
      filters: {
        role: 'admin',
        includeArchived: false,
        workspaceId: 'ws-1'
      },
      q: 'demo'
    });

    assert.equal(left, right);
  });

  it('round-trips cursors and rejects mismatches', () => {
    const signature = makeQuerySignature({
      q: 'demo',
      filters: {
        workspaceId: 'ws-1'
      }
    });
    const encoded = encodeCursor({
      signature,
      lastSeenAt: '2026-05-25T00:00:00.000Z',
      id: 'row-1'
    });

    assert.deepEqual(decodeCursor(encoded, signature), {
      signature,
      lastSeenAt: '2026-05-25T00:00:00.000Z',
      id: 'row-1'
    });
    assert.equal(decodeCursor(undefined, signature), null);
    assert.throws(() => decodeCursor('not-base64', signature), CursorMismatchError);
    assert.throws(
      () => decodeCursor(encoded, makeQuerySignature({ q: 'different', filters: { workspaceId: 'ws-1' } })),
      CursorMismatchError
    );
  });

  it('pages rows and only emits a next cursor when more items remain', () => {
    assert.deepEqual(
      pageWithCursor([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2, (item) => item.id),
      {
        items: [{ id: 'a' }, { id: 'b' }],
        nextCursor: 'b'
      }
    );
    assert.deepEqual(
      pageWithCursor([{ id: 'a' }, { id: 'b' }], 2, (item) => item.id),
      {
        items: [{ id: 'a' }, { id: 'b' }],
        nextCursor: undefined
      }
    );
  });

  it('matches search text across mixed fields case-insensitively', () => {
    assert.equal(containsSearchText(['Alpha', 123, null], ''), true);
    assert.equal(containsSearchText(['Alpha', 123, null], 'alp'), true);
    assert.equal(containsSearchText(['Alpha', 123, null], '123'), true);
    assert.equal(containsSearchText(['Alpha', 123, null], 'missing'), false);
  });
});
