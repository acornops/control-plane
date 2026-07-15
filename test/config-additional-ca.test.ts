import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';

describe('additional CA config', () => {
  it('requires a configured bundle to be readable', () => {
    assert.throws(
      () => parseAppConfig({ ADDITIONAL_CA_BUNDLE_FILE: '/missing/acornops-ca.pem' }),
      (error) =>
        error instanceof ZodError && Boolean(error.flatten().fieldErrors.ADDITIONAL_CA_BUNDLE_FILE?.length)
    );

    const dir = mkdtempSync(join(tmpdir(), 'acornops-cp-additional-ca-'));
    const caFile = join(dir, 'additional-ca.pem');
    writeFileSync(caFile, 'test ca');
    assert.equal(parseAppConfig({ ADDITIONAL_CA_BUNDLE_FILE: caFile }).ADDITIONAL_CA_BUNDLE_FILE, caFile);
  });
});
