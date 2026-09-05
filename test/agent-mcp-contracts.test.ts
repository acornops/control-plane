import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import {
  agentMcpCreateSchema,
  agentMcpUpdateSchema
} from '../src/controllers/agent-mcp-controller.js';

afterEach(() => mock.restoreAll());

test('Agent MCP create and update reject unsafe auth headers before the upstream boundary', () => {
  const upstream = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }));
  const unsafeNames = [
    ' X-Company',
    'X Company',
    'x-run-id',
    'mcp-session-id',
    'x'.repeat(129)
  ];

  for (const authHeaderName of unsafeNames) {
    assert.equal(agentMcpCreateSchema.safeParse({
      name: 'remote',
      url: 'https://mcp.example.test/rpc',
      authType: 'custom_header',
      credentialMode: 'workspace',
      authHeaderName
    }).success, false, `expected create rejection for ${authHeaderName}`);
    assert.equal(agentMcpUpdateSchema.safeParse({ authHeaderName }).success, false,
      `expected update rejection for ${authHeaderName}`);
  }

  for (const authHeaderPrefix of ['Bearer \r\nx-injected: true', 'x'.repeat(4097)]) {
    assert.equal(agentMcpCreateSchema.safeParse({
      name: 'remote',
      url: 'https://mcp.example.test/rpc',
      authType: 'custom_header',
      credentialMode: 'workspace',
      authHeaderName: 'X-Company',
      authHeaderPrefix
    }).success, false);
    assert.equal(agentMcpUpdateSchema.safeParse({ authHeaderPrefix }).success, false);
  }

  assert.equal(upstream.mock.callCount(), 0);
});

test('Agent MCP create and update accept a valid custom auth header shape', () => {
  assert.equal(agentMcpCreateSchema.safeParse({
    name: 'remote',
    url: 'https://mcp.example.test/rpc',
    authType: 'custom_header',
    credentialMode: 'workspace',
    authHeaderName: 'X-Company',
    authHeaderPrefix: 'Token '
  }).success, true);
  assert.equal(agentMcpUpdateSchema.safeParse({
    authHeaderName: 'X-Company',
    authHeaderPrefix: 'Token '
  }).success, true);
});

test('Agent OAuth create accepts omitted credential mode as individual by default', () => {
  assert.equal(agentMcpCreateSchema.safeParse({
    name: 'remote-oauth',
    url: 'https://mcp.example.test/rpc',
    authType: 'oauth'
  }).success, true);
  assert.equal(agentMcpCreateSchema.safeParse({
    name: 'remote-oauth',
    url: 'https://mcp.example.test/rpc',
    authType: 'oauth',
    credentialMode: 'workspace'
  }).success, false);
});
