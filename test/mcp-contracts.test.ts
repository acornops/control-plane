import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createMcpServerSchema, updateMcpServerSchema } from '../src/types/contracts.js';

const endpointVectors = JSON.parse(readFileSync(
  new URL('../docs/contracts/mcp-endpoint-vectors.json', import.meta.url),
  'utf8'
)) as {
  accept: Array<{ url: string }>;
  reject: Array<{ url: string; reason: string }>;
};

test('MCP server validation mirrors the gateway remote endpoint boundary', () => {
  for (const vector of endpointVectors.accept) {
    assert.equal(
      createMcpServerSchema.safeParse({ name: 'valid', url: vector.url }).success,
      true,
      `expected endpoint acceptance for ${vector.url}`
    );
  }

  for (const { url, reason } of endpointVectors.reject) {
    assert.equal(
      createMcpServerSchema.safeParse({ name: 'invalid', url }).success,
      false,
      `expected ${reason} endpoint rejection for ${url}`
    );
  }
  assert.equal(createMcpServerSchema.safeParse({
    name: 'encoded-secret',
    url: 'https://mcp.example.com/rpc?%61ccess_token=secret'
  }).success, false);
});

test('MCP server validation rejects a case-insensitive public/custom-auth header collision', () => {
  const parsed = createMcpServerSchema.safeParse({
    name: 'custom-auth',
    url: 'https://mcp.example.com/rpc',
    publicHeaders: { 'X-Company': 'acornops' },
    credentialMode: 'workspace',
    auth: { type: 'custom_header', headerName: 'x-company' }
  });

  assert.equal(parsed.success, false);
});

test('MCP server validation accepts top-level public headers', () => {
  const parsed = createMcpServerSchema.safeParse({
    name: 'github',
    url: 'https://mcp.example.com',
    publicHeaders: {
      'x-client-version': '2026-05'
    },
    auth: {
      type: 'bearer_token',
      headerName: 'Authorization',
      headerPrefix: 'Bearer '
    },
    credentialMode: 'individual'
  });

  assert.equal(parsed.success, true);
});

test('target OAuth create accepts omitted credential mode as individual by default', () => {
  assert.equal(createMcpServerSchema.safeParse({
    name: 'remote-oauth',
    url: 'https://mcp.example.com/rpc',
    auth: { type: 'oauth' }
  }).success, true);
  assert.equal(createMcpServerSchema.safeParse({
    name: 'remote-oauth',
    url: 'https://mcp.example.com/rpc',
    auth: { type: 'oauth' },
    credentialMode: 'workspace'
  }).success, false);
});

test('MCP server validation rejects removed auth static headers', () => {
  const parsed = createMcpServerSchema.safeParse({
    name: 'github',
    url: 'https://mcp.example.com',
    auth: {
      type: 'none',
      staticHeaders: {
        Authorization: 'Bearer leaked'
      }
    }
  });

  assert.equal(parsed.success, false);
});

test('MCP server validation rejects secret auth fields when auth is none', () => {
  const parsed = createMcpServerSchema.safeParse({
    name: 'github',
    url: 'https://mcp.example.com',
    auth: {
      type: 'none',
      secretValue: 'should-not-be-stored'
    }
  });

  assert.equal(parsed.success, false);
});

test('MCP server validation rejects credential-like public headers', () => {
  const parsed = updateMcpServerSchema.safeParse({
    publicHeaders: {
      Authorization: 'Bearer leaked'
    }
  });

  assert.equal(parsed.success, false);
});

test('MCP server validation rejects public headers that override platform context', () => {
  const parsed = updateMcpServerSchema.safeParse({
    publicHeaders: {
      'x-workspace-id': 'spoofed'
    }
  });

  assert.equal(parsed.success, false);
});

test('MCP server validation rejects duplicate public headers case-insensitively', () => {
  const parsed = updateMcpServerSchema.safeParse({
    publicHeaders: {
      'X-Trace-Id': 'one',
      'x-trace-id': 'two'
    }
  });

  assert.equal(parsed.success, false);
});

test('MCP server validation rejects unsafe auth header names and values', () => {
  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'none',
      headerPrefix: ''
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'custom_header',
      headerName: 'x-run-id'
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'bearer_token',
      headerPrefix: 'Bearer \r\nx-injected: true'
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'custom_header',
      headerName: 'mcp-session-id'
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'custom_header',
      headerName: 'x'.repeat(129)
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'custom_header',
      headerName: 'X-Company',
      headerPrefix: 'x'.repeat(4097)
    }
  }).success, false);
});

test('MCP server updates keep endpoint and tool definitions immutable', () => {
  assert.equal(updateMcpServerSchema.safeParse({
    url: 'https://replacement.example.com/mcp'
  }).success, false);
  assert.equal(updateMcpServerSchema.safeParse({
    tools: [{ name: 'unexpected.tool' }]
  }).success, false);
  assert.equal(updateMcpServerSchema.safeParse({
    removeTools: ['existing.tool']
  }).success, false);
  assert.equal(updateMcpServerSchema.safeParse({
    expectedRevision: 2
  }).success, false);
});
