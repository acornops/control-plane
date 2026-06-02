import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { config } from '../../src/config.js';
import { internalClientTlsOptions } from '../../src/infra/internal-tls.js';

const mutableConfig = config as typeof config & {
  INTERNAL_TRANSPORT_TLS_ENABLED: boolean;
  INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT: boolean;
  INTERNAL_TRANSPORT_TLS_CA_FILE?: string;
  INTERNAL_TRANSPORT_TLS_CERT_FILE?: string;
  INTERNAL_TRANSPORT_TLS_KEY_FILE?: string;
};

const original = {
  enabled: config.INTERNAL_TRANSPORT_TLS_ENABLED,
  requireClientCert: config.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT,
  caFile: config.INTERNAL_TRANSPORT_TLS_CA_FILE,
  certFile: config.INTERNAL_TRANSPORT_TLS_CERT_FILE,
  keyFile: config.INTERNAL_TRANSPORT_TLS_KEY_FILE
};

function writeTlsFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'acornops-internal-tls-'));
  const caFile = join(dir, 'ca.crt');
  const certFile = join(dir, 'tls.crt');
  const keyFile = join(dir, 'tls.key');
  writeFileSync(caFile, 'test ca');
  writeFileSync(certFile, 'test cert');
  writeFileSync(keyFile, 'test key');
  return { caFile, certFile, keyFile };
}

afterEach(() => {
  mutableConfig.INTERNAL_TRANSPORT_TLS_ENABLED = original.enabled;
  mutableConfig.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT = original.requireClientCert;
  mutableConfig.INTERNAL_TRANSPORT_TLS_CA_FILE = original.caFile;
  mutableConfig.INTERNAL_TRANSPORT_TLS_CERT_FILE = original.certFile;
  mutableConfig.INTERNAL_TRANSPORT_TLS_KEY_FILE = original.keyFile;
});

describe('internal TLS client options', () => {
  it('omits client certs in server-TLS-only mode', () => {
    const files = writeTlsFiles();
    mutableConfig.INTERNAL_TRANSPORT_TLS_ENABLED = true;
    mutableConfig.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT = false;
    mutableConfig.INTERNAL_TRANSPORT_TLS_CA_FILE = files.caFile;
    mutableConfig.INTERNAL_TRANSPORT_TLS_CERT_FILE = files.certFile;
    mutableConfig.INTERNAL_TRANSPORT_TLS_KEY_FILE = files.keyFile;

    const options = internalClientTlsOptions();

    assert.ok(options.ca);
    assert.equal(options.cert, undefined);
    assert.equal(options.key, undefined);
  });

  it('includes client certs in mTLS mode', () => {
    const files = writeTlsFiles();
    mutableConfig.INTERNAL_TRANSPORT_TLS_ENABLED = true;
    mutableConfig.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT = true;
    mutableConfig.INTERNAL_TRANSPORT_TLS_CA_FILE = files.caFile;
    mutableConfig.INTERNAL_TRANSPORT_TLS_CERT_FILE = files.certFile;
    mutableConfig.INTERNAL_TRANSPORT_TLS_KEY_FILE = files.keyFile;

    const options = internalClientTlsOptions();

    assert.ok(options.ca);
    assert.ok(options.cert);
    assert.ok(options.key);
  });
});
