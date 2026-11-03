export type VirtualMachinePlatform =
  | { osFamily: 'linux'; serviceManager: 'systemd' }
  | { osFamily: 'windows'; serviceManager: 'scm' };

export function parseVirtualMachinePlatform(value: { osFamily?: unknown; serviceManager?: unknown }): VirtualMachinePlatform | null {
  if ((value.osFamily === undefined || value.osFamily === 'linux')
    && (value.serviceManager === undefined || value.serviceManager === 'systemd')) {
    return { osFamily: 'linux', serviceManager: 'systemd' };
  }
  return value.osFamily === 'windows' && value.serviceManager === 'scm'
    ? { osFamily: 'windows', serviceManager: 'scm' } : null;
}

const WINDOWS_READ_TOOLS = new Set([
  'get_host_summary', 'list_filesystems', 'list_processes', 'list_services',
  'get_service', 'list_listeners', 'query_logs', 'get_process'
]);

export function isWindowsReadTool(name: unknown, capability: unknown): boolean {
  return typeof name === 'string' && capability === 'read' && WINDOWS_READ_TOOLS.has(name);
}
