import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import publicHeaderVectorsJson from '../../docs/contracts/mcp-public-header-vectors.json' with { type: 'json' };
import {
  CatalogDestinationValidationError,
  validateAgentCatalogDestination
} from '../../src/services/catalog-destination-validator.js';
import {
  InvalidMcpPublicHeadersError,
  validateMcpPublicHeaders
} from '../../src/services/mcp-public-header-policy.js';
import type { AgentDefinition } from '../../src/types/agents.js';

const publicHeaderVectors = publicHeaderVectorsJson as {
  cases: Array<{ name: string; headers: Array<[string, string]>; valid: boolean }>;
};

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
  it('matches the cross-runtime public-header vectors', () => {
    for (const vector of publicHeaderVectors.cases) {
      const headers = Object.fromEntries(vector.headers);
      if (vector.valid) {
        assert.deepEqual(validateMcpPublicHeaders(headers), headers, vector.name);
      } else {
        assert.throws(() => validateMcpPublicHeaders(headers), InvalidMcpPublicHeadersError, vector.name);
      }
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
