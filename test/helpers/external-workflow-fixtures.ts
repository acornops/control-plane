import { repo } from '../../src/store/repository.js';
import { createExternalIntegrationRequest } from './controller-regression-fixtures.js';

export function withWriteCapability(
  request: ReturnType<typeof createExternalIntegrationRequest>
): ReturnType<typeof createExternalIntegrationRequest> & {
  externalIntegrationClient: { allowedCapabilities: string[] };
} {
  const enabled = request as ReturnType<typeof createExternalIntegrationRequest> & {
    externalIntegrationClient: { allowedCapabilities: string[] };
  };
  enabled.externalIntegrationClient = {
    allowedCapabilities: ['read_workspace_data', 'create_sessions', 'create_read_only_runs', 'create_read_write_runs']
  };
  return enabled;
}

export function installExternalWriteGrant(): void {
  repo.getExternalIntegrationWorkspaceGrant = async () => ({
    workspaceId: 'workspace-1',
    capabilities: ['read_workspace_data', 'create_sessions', 'create_read_only_runs', 'create_read_write_runs'],
    grantedByUserId: 'user-1',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z'
  });
}
