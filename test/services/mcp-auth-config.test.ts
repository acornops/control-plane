import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveEffectiveMcpAuthConfig,
  validateEffectiveMcpAuthConfig
} from '../../src/services/mcp-auth-config.js';

test('MCP auth transitions do not inherit a bearer prefix into custom headers', () => {
  const effective = resolveEffectiveMcpAuthConfig({
    authType: 'bearer_token',
    credentialMode: 'workspace',
    headerName: 'Authorization',
    headerPrefix: 'Bearer '
  }, {
    authType: 'custom_header',
    headerName: 'X-Api-Key'
  });

  assert.deepEqual(effective, {
    authType: 'custom_header',
    credentialMode: 'workspace',
    headerName: 'X-Api-Key',
    headerPrefix: ''
  });
});

test('MCP auth updates are validated against current plus patch state', () => {
  const unauthenticated = {
    authType: 'none' as const,
    credentialMode: 'none' as const
  };
  assert.equal(validateEffectiveMcpAuthConfig(unauthenticated, {
    authType: 'bearer_token'
  }), 'Authenticated MCP servers require workspace or individual credentials.');
  assert.equal(validateEffectiveMcpAuthConfig(unauthenticated, {
    authType: 'custom_header',
    credentialMode: 'workspace'
  }), 'Custom-header authentication requires a header name.');
  assert.equal(validateEffectiveMcpAuthConfig(unauthenticated, {
    authType: 'oauth',
    credentialMode: 'workspace'
  }), 'OAuth requires individual credentials.');
  assert.equal(validateEffectiveMcpAuthConfig(unauthenticated, {
    authType: 'oauth',
    credentialMode: 'individual'
  }), null);
});

test('MCP auth updates reject public/custom-auth header collisions across current plus patch state', () => {
  assert.equal(validateEffectiveMcpAuthConfig({
    authType: 'none',
    credentialMode: 'none',
    publicHeaders: { 'X-Company': 'acornops' }
  }, {
    authType: 'custom_header',
    credentialMode: 'workspace',
    headerName: 'x-company'
  }), 'publicHeaders must not duplicate the custom authentication header.');

  assert.equal(validateEffectiveMcpAuthConfig({
    authType: 'custom_header',
    credentialMode: 'workspace',
    headerName: 'X-Company'
  }, {
    publicHeaders: { 'x-company': 'acornops' }
  }), 'publicHeaders must not duplicate the custom authentication header.');
});

test('MCP auth updates validate inherited plus patched auth header configuration', () => {
  const current = {
    authType: 'custom_header' as const,
    credentialMode: 'workspace' as const,
    headerName: 'X-Company',
    headerPrefix: 'Token '
  };

  assert.match(validateEffectiveMcpAuthConfig(current, {
    headerName: 'mcp-session-id'
  }) || '', /reserved by the platform/i);
  assert.match(validateEffectiveMcpAuthConfig(current, {
    headerName: 'X Company'
  }) || '', /valid HTTP header token/i);
  assert.match(validateEffectiveMcpAuthConfig(current, {
    headerPrefix: 'Token \r\nx-injected: true'
  }) || '', /CR or LF/i);
  assert.match(validateEffectiveMcpAuthConfig(current, {
    headerPrefix: 'x'.repeat(4097)
  }) || '', /4096 characters or fewer/i);
});
