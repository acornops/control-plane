import type { VirtualMachineSnapshot, VirtualMachineTarget } from '../../src/types/domain.js';

export const windowsVm: VirtualMachineTarget = {
  id: 'vm-windows', workspaceId: 'workspace-1', name: 'Windows VM', hostname: 'server',
  osFamily: 'windows', serviceManager: 'scm', status: 'online', allowedLogSources: ['Application', 'System'],
  agentAccessMode: 'read_only', restartServices: [], pendingAgentAccessPolicy: null,
  permissionMode: 'read_only', permissionModeOverride: null, permissionModeSource: 'deployment_default',
  createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z'
};
export const failedService = {
  name: 'BackupEngine', display_name: 'Backup service', state: 'Stopped', start_mode: 'Auto',
  process_id: 0, exit_code: 1066, service_specific_exit_code: 42
};
export function windowsSnapshot(overrides: Record<string, unknown> = {}): VirtualMachineSnapshot {
  return {
    targetId: windowsVm.id, workspaceId: windowsVm.workspaceId, timestamp: '2026-10-31T01:00:00.000Z',
    data: {
      schema_version: 'acornops.agentv-windows-snapshot.v1',
      host_summary: {
        os_family: 'windows', hostname: 'server', version: '10.0', build: '20348', product_type: 3,
        architecture: 'x64', system_volume: 'D:', uptime_seconds: 100,
        cpu: { usage_percent: 5, sampled_ms: 100 },
        memory: { total_bytes: 1000, available_bytes: 300, used_bytes: 700, used_percent: 70 },
        collector_health: [{ collector: 'windows_host', status: 'ok', duration_ms: 1 }]
      },
      filesystems: [
        { volume: 'C:', filesystem: 'NTFS', total_bytes: 1000, used_bytes: 950, free_bytes: 50, used_percent: 95 },
        { volume: 'D:', filesystem: 'NTFS', total_bytes: 2000, used_bytes: 500, free_bytes: 1500, used_percent: 25 }
      ],
      degraded_services: [failedService], top_processes: [], listeners: [],
      findings: [
        { severity: 'critical', code: 'SERVICE_FAILED', name: failedService.name, summary: 'Backup failed' },
        { severity: 'critical', code: 'FILESYSTEM_PRESSURE', volume: 'C:', summary: 'Volume pressure' }
      ],
      collector_health: ['windows_host', 'windows_volumes', 'windows_services', 'windows_processes', 'windows_listeners']
        .map((collector) => ({ collector, status: 'ok', duration_ms: 1 })),
      finding_coverage: { filesystems: 'complete', services: 'complete' },
      truncation: { filesystems: 0, services: 0, processes: 0, listeners: 0 },
      ...overrides
    }
  };
}
