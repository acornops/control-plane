import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const controller = readFileSync(resolve(testDir, '../src/controllers/workflow-capability-preview-controller.ts'), 'utf8');
const routes = readFileSync(resolve(testDir, '../src/routes/workflows.ts'), 'utf8');

describe('workflow capability preview controller safety', () => {
  it('registers a dedicated preview route without importing mutation paths', () => {
    assert.match(routes, /post\('\/workflows\/:workflowId\/capabilities-preview'/);
    for (const mutation of [
      'createWorkflowSession',
      'createWorkflowExecution',
      'recordWorkspaceAuditEvent',
      'createRunToolApproval',
      'insertWorkspaceAuditEvent'
    ]) {
      assert.doesNotMatch(controller, new RegExp(`\\b${mutation}\\b`));
    }
  });

  it('does not declare sensitive response fields', () => {
    for (const field of ['credentialValue', 'publicHeaders', 'serverUrl', 'inputSchema', 'toolArguments', 'coordinatorId', 'provider', 'profileId', 'profileName', 'documentationUrls']) {
      assert.doesNotMatch(controller, new RegExp(`\\b${field}\\b`));
    }
    assert.match(controller, /authType = server\.auth_type === 'custom_header'/);
    assert.match(controller, /serverId: server\.id/);
    assert.match(controller, /serverName: server\.server_name/);
    assert.match(controller, /authRequirement: \{/);
    assert.match(controller, /const credentialLabel = authType === 'bearer_token'/);
    assert.match(controller, /requiredInformation: \[\{/);
    assert.match(controller, /server\.auth_scope === 'personal'/);
    assert.match(controller, /!server\.auth_scope && server\.auth_type !== 'none'/);
    assert.match(controller, /allowedServerIds\.has\(server\.id\)/);
    assert.match(controller, /const mcpRequirements = genericAuthRequirements/);
    assert.doesNotMatch(controller, /sourceControlRequirements|SOURCE_CONTROL_INTEGRATION_PROFILES|github|gitlab/);
  });
});
