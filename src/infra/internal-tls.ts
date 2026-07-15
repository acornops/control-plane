import { readFileSync } from 'node:fs';
import type { ServerOptions } from 'node:https';
import type { AgentOptions } from 'node:https';
import { config } from '../config.js';

function internalCa(): Buffer | undefined {
  return config.INTERNAL_TRANSPORT_TLS_CA_FILE ? readFileSync(config.INTERNAL_TRANSPORT_TLS_CA_FILE) : undefined;
}

function internalClientCas(): Buffer[] | undefined {
  const paths = [config.INTERNAL_TRANSPORT_TLS_CA_FILE, config.ADDITIONAL_CA_BUNDLE_FILE].filter(
    (path): path is string => Boolean(path)
  );
  return paths.length > 0 ? paths.map((path) => readFileSync(path)) : undefined;
}

export function internalServerTlsOptions(): ServerOptions {
  if (!config.INTERNAL_TRANSPORT_TLS_ENABLED) {
    throw new Error('Internal transport TLS is disabled');
  }
  return {
    cert: readFileSync(config.INTERNAL_TRANSPORT_TLS_CERT_FILE || ''),
    key: readFileSync(config.INTERNAL_TRANSPORT_TLS_KEY_FILE || ''),
    ca: internalCa(),
    requestCert: config.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT,
    rejectUnauthorized: config.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT
  };
}

export function internalClientTlsOptions(): AgentOptions {
  if (!config.INTERNAL_TRANSPORT_TLS_ENABLED) {
    return {};
  }
  if (!config.INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT) {
    return {
      ca: internalClientCas()
    };
  }
  return {
    cert: readFileSync(config.INTERNAL_TRANSPORT_TLS_CERT_FILE || ''),
    key: readFileSync(config.INTERNAL_TRANSPORT_TLS_KEY_FILE || ''),
    ca: internalClientCas()
  };
}
