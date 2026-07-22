import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpServerSchema, updateMcpServerSchema } from '../src/types/contracts.js';

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
      headerName: 'x-run-id'
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'bearer_token',
      secretValue: 'secret',
      headerPrefix: 'Bearer \r\nx-injected: true'
    }
  }).success, false);

  assert.equal(updateMcpServerSchema.safeParse({
    auth: {
      type: 'bearer_token',
      secretValue: 'x'.repeat(4096)
    }
  }).success, false);
});
