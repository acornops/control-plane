import type { TargetIssue, VirtualMachineSnapshot, VirtualMachineTarget } from '../types/domain.js';
import type { TargetIssueObservationInput } from './target-issue-derivation.js';
import { isFailedWindowsService } from './windows-vm-snapshot.js';

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function deriveWindowsIssueObservations(vm: VirtualMachineTarget, snapshot: VirtualMachineSnapshot): TargetIssueObservationInput[] {
  const services = new Map(records(snapshot.data.degraded_services).map((service) => [text(service.name), service]));
  const findings = new Map<string, Record<string, unknown>>();
  for (const service of services.values()) {
    if (isFailedWindowsService(service)) findings.set(`SERVICE_FAILED:${service.name}`, {
      severity: 'critical', code: 'SERVICE_FAILED', name: service.name,
      summary: `Windows service ${service.name} stopped with exit code ${service.exit_code}`
    });
  }
  for (const finding of records(snapshot.data.findings)) {
    const service = services.get(text(finding.name));
    if (finding.code === 'SERVICE_FAILED' && service && !isFailedWindowsService(service)) continue;
    findings.set(`${finding.code}:${finding.name || finding.volume || ''}`, finding);
  }
  return [...findings.values()].filter((finding) => finding.severity === 'critical').map((finding) => {
    const serviceFinding = finding.code === 'SERVICE_FAILED';
    const objectKind = serviceFinding ? 'scm_service' : 'host';
    const objectName = text(finding.name || finding.volume) || vm.hostname || vm.name;
    const reason = text(finding.code);
    const summary = text(finding.summary);
    return {
      targetId: vm.id, workspaceId: vm.workspaceId, targetType: 'virtual_machine', snapshotTs: snapshot.timestamp,
      // SCM names are case-insensitive; failure code changes do not create a new issue.
      fingerprint: ['vm', vm.id, objectKind, objectName.toLowerCase(), reason.toLowerCase()].join('|'),
      issueType: serviceFinding ? 'vm_service_unhealthy' : 'vm_host_finding', severity: 'critical',
      title: serviceFinding ? `Service ${objectName} failed` : summary, summary, message: summary,
      scopeKind: null, scopeName: null, objectKind, objectName, reason, findingId: null,
      evidence: { source: 'vm_windows_snapshot_finding', finding, ...(services.has(objectName) ? { service: services.get(objectName) } : {}) },
      searchText: [summary, vm.name, objectName, reason].join(' ').toLowerCase()
    };
  });
}

export function canRecoverWindowsIssue(snapshot: VirtualMachineSnapshot, issue: Pick<TargetIssue, 'issueType' | 'reason' | 'objectName'>): boolean {
  const healthy = (collector: string): boolean => {
    const entries = records(snapshot.data.collector_health).filter((entry) => entry.collector === collector);
    return entries.length > 0 && entries.every((entry) => entry.status === 'ok');
  };
  const coverage = snapshot.data.finding_coverage as Record<string, unknown> | undefined;
  if (issue.issueType === 'vm_service_unhealthy') return healthy('windows_services') && coverage?.services === 'complete';
  if (issue.reason === 'FILESYSTEM_PRESSURE') return healthy('windows_volumes') && coverage?.filesystems === 'complete';
  if (issue.reason === 'MEMORY_PRESSURE') {
    const host = snapshot.data.host_summary as { memory?: { used_percent?: number } } | null | undefined;
    const usedPercent = host?.memory?.used_percent;
    return healthy('windows_host') && typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent < 90;
  }
  return false;
}

export function summarizeWindowsMetrics(snapshot: VirtualMachineSnapshot): Record<string, unknown> | null {
  const host = snapshot.data.host_summary as Record<string, unknown> | null | undefined;
  if (!host) return null;
  const memory = host.memory as Record<string, unknown>;
  const cpu = host.cpu as Record<string, unknown>;
  return {
    osFamily: 'windows', systemVolume: host.system_volume, loadAverage: [], cpuUsagePercent: cpu.usage_percent,
    memory: { ...memory, free_bytes: memory.available_bytes }, swap: null, disks: snapshot.data.filesystems
  };
}
