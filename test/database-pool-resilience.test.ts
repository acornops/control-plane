import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from '../src/infra/db.js';

describe('database pool resilience', () => {
  it('handles idle client errors without allowing EventEmitter to crash the process', () => {
    assert.ok(db.listenerCount('error') > 0);
  });
});
