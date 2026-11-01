import { isWindowsSnapshot } from './windows-vm-snapshot.js';
import { canRecoverWindowsIssue } from './windows-vm-interpretation.js';
import type { TargetIssue, VirtualMachineSnapshot } from '../types/domain.js';

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

/** Require positive collection coverage before treating an absent VM finding as clean. */
export function canRecoverVirtualMachineIssue(
  snapshot: VirtualMachineSnapshot,
  issue: Pick<TargetIssue, 'issueType' | 'reason' | 'objectName'>
): boolean {
  if (isWindowsSnapshot(snapshot)) return canRecoverWindowsIssue(snapshot, issue);
  const data = snapshot.data;
  const health = records(data.collector_health);
  const healthy = (collector: string): boolean => {
    const entries = health.filter((entry) => entry.collector === collector);
    return entries.length > 0 && entries.every((entry) => entry.status === 'ok');
  };
  const truncation = data.truncation as Record<string, unknown> | undefined;
  const coverage = data.finding_coverage as Record<string, unknown> | undefined;
  const completeFilesystems = truncation?.filesystems === 0;
  const completeServices = truncation?.services === 0;
  if (issue.reason === 'FILESYSTEM_PRESSURE') {
    return healthy('filesystems') && (coverage?.filesystems === 'complete' || completeFilesystems || records(data.filesystems)
      .some((filesystem) => filesystem.mount === issue.objectName));
  }
  if (issue.issueType === 'vm_service_unhealthy') {
    return healthy('systemd') && (coverage?.services === 'complete' || completeServices);
  }
  if (issue.reason === 'MEMORY_PRESSURE') {
    const host = data.host_summary as { memory?: { used_percent?: number } } | null | undefined;
    return healthy('host_facts') && Number.isFinite(host?.memory?.used_percent);
  }
  return healthy('host_facts') && healthy('filesystems') && healthy('systemd')
    && completeFilesystems && completeServices;
}
