import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { intersectGrantedTargetRunTools, type TargetRunToolResolution } from '../src/services/target-run-tool-resolution.js';

describe('workflow target tool intersection', () => {
  it('uses one deterministic grant intersection for preview and execution bootstrap', () => {
    const resolution: TargetRunToolResolution = {
      targetSupportsWrite: true,
      allowedToolNames: ['query_logs', 'restart_service'],
      allowedToolSpecs: [
        { name: 'query_logs', server_id: 'target-server', tool_name: 'query_logs', description: 'Read logs', input_schema: {}, capability: 'read' },
        { name: 'restart_service', server_id: 'target-server', tool_name: 'restart_service', description: 'Restart service', input_schema: {}, capability: 'write' }
      ],
      allowedToolOperations: { query_logs: 'read', restart_service: 'write' },
      allowedToolRefs: [
        { serverId: 'target-server', toolName: 'query_logs' },
        { serverId: 'target-server', toolName: 'restart_service' }
      ],
      allowedNativeTools: [],
      previewItems: [
        { id: 'query_logs', name: 'query_logs', description: 'Read logs', capability: 'read', runtimeKind: 'function', source: 'builtin' },
        { id: 'restart_service', name: 'restart_service', description: 'Restart service', capability: 'write', runtimeKind: 'function', source: 'builtin' }
      ],
      summary: { totalAllowed: 2, functionAllowed: 2, nativeAllowed: 0, readAllowed: 1, writeAllowed: 1, configuredWrite: 1, excludedWrite: 0 },
      writeUnavailableReason: null,
      confirmationRequiredForWrite: true,
      approvalTimeoutSeconds: 900
    };
    const grants = [{ serverId: 'target-server', toolName: 'query_logs' }];

    const preview = intersectGrantedTargetRunTools(resolution, ['query_logs'], grants);
    const bootstrap = intersectGrantedTargetRunTools(resolution, ['query_logs'], grants);

    assert.deepEqual(preview, bootstrap);
    assert.deepEqual(preview.allowedToolNames, ['query_logs']);
    assert.deepEqual(preview.allowedToolRefs, grants);
    assert.deepEqual(preview.allowedToolOperations, { query_logs: 'read' });
  });
});
