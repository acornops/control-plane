import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CatalogDestinationValidationError,
  validateAgentCatalogDestination
} from '../../src/services/catalog-destination-validator.js';
import {
  InvalidMcpPublicHeadersError,
  validateMcpPublicHeaders
} from '../../src/services/mcp-public-header-policy.js';
import type { AgentDefinition } from '../../src/types/agents.js';

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    kind: 'specialist',
    targetScope: { type: 'selected_target', targetTypes: ['kubernetes'], targetIds: ['target-1'] },
    ...overrides
  } as AgentDefinition;
}

describe('MCP catalog trust-boundary validation', () => {
  it('accepts safe public headers and rejects credentials, reserved names, duplicate case, and CR/LF', () => {
    assert.deepEqual(validateMcpPublicHeaders({ 'X-Catalog-Version': 'v2' }), { 'X-Catalog-Version': 'v2' });
    for (const headers of [
      { Authorization: 'secret' },
      { 'X-Workspace-Id': 'spoofed' },
      { 'X-Trace': 'one', 'x-trace': 'two' },
      { 'X-Trace': 'one\r\ntwo' }
    ]) {
      assert.throws(() => validateMcpPublicHeaders(headers), InvalidMcpPublicHeadersError);
    }
  });

  it('uses one destination validator for manager and target-scope enforcement', async () => {
    const findTarget = async (_workspaceId: string, targetId: string) => (
      targetId === 'target-1' ? { targetType: 'virtual_machine' as const } : null
    );
    await assert.rejects(
      validateAgentCatalogDestination({
        agent: agent({ kind: 'manager' }),
        targetConstraints: { targetTypes: [], targetIds: [] },
        findTarget
      }),
      CatalogDestinationValidationError
    );
    await assert.rejects(
      validateAgentCatalogDestination({
        agent: agent(),
        targetConstraints: { targetTypes: ['kubernetes'], targetIds: ['target-1'] },
        findTarget
      }),
      /actual type|has type virtual_machine/
    );
    await assert.rejects(
      validateAgentCatalogDestination({
        agent: agent(),
        targetConstraints: { targetTypes: ['kubernetes'], targetIds: ['missing'] },
        findTarget
      }),
      CatalogDestinationValidationError
    );
  });
});
