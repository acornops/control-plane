import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMcpFailureUnavailableForInteractivePrincipal } from '../src/services/interactive-mcp-tool-availability.js';

describe('automatic investigation MCP availability', () => {
  const individualCredentialFailure = {
    serverId: 'private-tools',
    toolName: 'lookup_incident',
    code: 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED' as const
  };

  it('omits user-bound tools for the automatic system principal', () => {
    assert.equal(
      isMcpFailureUnavailableForInteractivePrincipal(
        { type: 'service_identity', id: 'system-auto-triage' },
        individualCredentialFailure
      ),
      true
    );
  });

  it('keeps principal requirements blocking for ordinary service identities', () => {
    assert.equal(
      isMcpFailureUnavailableForInteractivePrincipal(
        { type: 'service_identity', id: 'workflow-bot' },
        individualCredentialFailure
      ),
      false
    );
  });
});
