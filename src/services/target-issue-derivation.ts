import {
  ClusterSnapshot,
  KubernetesCluster,
  TargetIssueSeverity,
  TargetType,
  VirtualMachineSnapshot,
  VirtualMachineTarget
} from '../types/domain.js';
import { SnapshotFindingListItem, severityRank } from './snapshot-derived-data.js';

export interface TargetIssueObservationInput {
  targetId: string;
  workspaceId: string;
  targetType: TargetType;
  snapshotTs: string;
  fingerprint: string;
  issueType: string;
  severity: TargetIssueSeverity;
  title: string;
  summary: string;
  message: string;
  scopeKind: string | null;
  scopeName: string | null;
  objectKind: string | null;
  objectName: string | null;
  reason: string | null;
  findingId: string | null;
  evidence: Record<string, unknown>;
  searchText: string;
}

function toArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFingerprintPart(value: unknown, fallback = 'unknown'): string {
  return String(value || fallback).trim().toLowerCase().replace(/\s+/g, '-');
}

function buildSearchText(fields: unknown[]): string {
  return fields.map((field) => String(field || '').trim()).filter(Boolean).join(' ').toLowerCase();
}

function compareSeverity(left: TargetIssueSeverity, right: TargetIssueSeverity): number {
  return severityRank(left) - severityRank(right);
}

function strongestSeverity(...severities: TargetIssueSeverity[]): TargetIssueSeverity {
  return [...severities].sort(compareSeverity)[0] || 'info';
}

function getPodRestartCount(pod: Record<string, unknown>): number {
  const statusRestartTotal = toArray(pod.containerStatuses).reduce(
    (total, status) => total + numberValue(status.restartCount),
    0
  );
  return Math.max(numberValue(pod.restartCount), statusRestartTotal);
}

function getContainerReason(status: Record<string, unknown>): string {
  const state = (status.state || {}) as Record<string, unknown>;
  const lastState = (status.lastState || {}) as Record<string, unknown>;
  const waiting = (state.waiting || {}) as Record<string, unknown>;
  const terminated = (state.terminated || {}) as Record<string, unknown>;
  const lastTerminated = (lastState.terminated || {}) as Record<string, unknown>;
  return text(waiting.reason) || text(terminated.reason) || text(lastTerminated.reason);
}

function getProblemContainer(pod: Record<string, unknown>, fallbackReason = ''): Record<string, unknown> | null {
  const statuses = toArray(pod.containerStatuses);
  const reason = fallbackReason.toLowerCase();
  return statuses.find((status) => {
    const containerReason = getContainerReason(status).toLowerCase();
    return containerReason && (reason.includes(containerReason) || containerReason.includes(reason) || /crash|backoff|oom|error|failed/.test(containerReason));
  }) || statuses.find((status) => numberValue(status.restartCount) > 0) || statuses[0] || null;
}

function getOwnerReferences(item: Record<string, unknown>): Array<Record<string, unknown>> {
  return toArray(item.ownerReferences);
}

function inferControllerOwner(pod: Record<string, unknown>): { kind: string; name: string } {
  const owner = getOwnerReferences(pod).find((entry) => entry.controller === true) || getOwnerReferences(pod)[0];
  const kind = text(owner?.kind);
  const name = text(owner?.name);
  if (!kind || !name) return { kind: 'Pod', name: text(pod.name, 'unknown') };
  if (kind === 'ReplicaSet') {
    const deploymentName = name.replace(/-[a-z0-9]{5,10}$/i, '');
    if (deploymentName && deploymentName !== name) return { kind: 'Deployment', name: deploymentName };
  }
  return { kind, name };
}

function podByName(snapshot: ClusterSnapshot): Map<string, Record<string, unknown>> {
  const resources = (snapshot.data.resources || {}) as Record<string, unknown>;
  const pods = new Map<string, Record<string, unknown>>();
  for (const pod of toArray(resources.pods)) {
    const namespace = text(pod.namespace, 'default');
    const name = text(pod.name);
    if (name) pods.set(`${namespace}/${name}`, pod);
  }
  return pods;
}

function podFingerprint(
  cluster: KubernetesCluster,
  namespace: string,
  pod: Record<string, unknown> | undefined,
  podName: string,
  issueClass: 'pod-unhealthy' | 'pod-pending',
  reason: string
): { fingerprint: string; owner: { kind: string; name: string }; containerName: string } {
  const owner = pod ? inferControllerOwner(pod) : { kind: 'Pod', name: podName };
  const container = pod ? getProblemContainer(pod, reason) : null;
  const containerName = text(container?.name);
  const containerPart = issueClass === 'pod-unhealthy' ? normalizeFingerprintPart(containerName || 'pod') : 'pod';
  return {
    fingerprint: [
      'kubernetes',
      cluster.id,
      normalizeFingerprintPart(namespace),
      normalizeFingerprintPart(owner.kind),
      normalizeFingerprintPart(owner.name),
      containerPart,
      issueClass
    ].join('|'),
    owner,
    containerName
  };
}

function classifyPodFinding(finding: SnapshotFindingListItem): 'pod-unhealthy' | 'pod-pending' | null {
  const reason = `${finding.reason || ''} ${finding.title} ${finding.message}`.toLowerCase();
  if (reason.includes('pending') || reason.includes('unschedulable') || reason.includes('failedscheduling')) return 'pod-pending';
  if (/crash|backoff|oom|unhealthy|failed|error/.test(reason)) return 'pod-unhealthy';
  return null;
}

function buildPodObservation(
  cluster: KubernetesCluster,
  snapshot: ClusterSnapshot,
  finding: SnapshotFindingListItem,
  pod: Record<string, unknown> | undefined,
  issueClass: 'pod-unhealthy' | 'pod-pending'
): TargetIssueObservationInput {
  const namespace = finding.namespace || 'default';
  const podName = finding.objectName || text(pod?.name, 'unknown');
  const reason = finding.reason || (issueClass === 'pod-pending' ? 'Pending' : 'Unhealthy');
  const restartCount = pod ? getPodRestartCount(pod) : 0;
  const { fingerprint, owner, containerName } = podFingerprint(cluster, namespace, pod, podName, issueClass, reason);
  const title =
    owner.kind === 'Pod'
      ? finding.title
      : `${owner.kind} ${owner.name} has ${issueClass === 'pod-pending' ? 'pending' : 'unhealthy'} pods`;
  const summary =
    restartCount > 0
      ? `${finding.message} Restart count: ${restartCount}.`
      : finding.message;
  const severity = strongestSeverity(finding.severity, restartCount >= 50 ? 'critical' : restartCount >= 10 ? 'warning' : finding.severity);
  return {
    targetId: cluster.id,
    workspaceId: cluster.workspaceId,
    targetType: 'kubernetes',
    snapshotTs: snapshot.timestamp,
    fingerprint,
    issueType: issueClass === 'pod-pending' ? 'kubernetes_pod_pending' : 'kubernetes_pod_unhealthy',
    severity,
    title,
    summary,
    message: finding.message,
    scopeKind: 'Namespace',
    scopeName: namespace,
    objectKind: owner.kind,
    objectName: owner.name,
    reason,
    findingId: finding.id,
    evidence: {
      source: 'snapshot_finding',
      podName,
      namespace,
      owner,
      containerName,
      restartCount,
      reason,
      findingId: finding.id
    },
    searchText: buildSearchText([title, summary, cluster.name, namespace, owner.kind, owner.name, podName, reason, containerName])
  };
}

function buildGenericKubernetesObservation(
  cluster: KubernetesCluster,
  snapshot: ClusterSnapshot,
  finding: SnapshotFindingListItem
): TargetIssueObservationInput | null {
  if (finding.severity === 'info') return null;
  const objectKind = text(finding.objectKind);
  const objectName = text(finding.objectName);
  if (!objectKind || !objectName) return null;
  const namespace = finding.namespace || null;
  let issueType = 'kubernetes_resource_unhealthy';
  let fingerprintReason = finding.reason || issueType;
  if (objectKind === 'Node') issueType = 'kubernetes_node_not_ready';
  if (objectKind === 'PersistentVolumeClaim') issueType = 'kubernetes_pvc_unhealthy';
  if (objectKind === 'Job') issueType = 'kubernetes_job_failed';
  if (objectKind === 'Node') fingerprintReason = 'NotReady';
  if (objectKind === 'Job') fingerprintReason = 'Failed';
  const reason = finding.reason || issueType;
  const fingerprint = [
    'kubernetes',
    cluster.id,
    normalizeFingerprintPart(namespace || 'cluster'),
    normalizeFingerprintPart(objectKind),
    normalizeFingerprintPart(objectName),
    normalizeFingerprintPart(fingerprintReason)
  ].join('|');
  return {
    targetId: cluster.id,
    workspaceId: cluster.workspaceId,
    targetType: 'kubernetes',
    snapshotTs: snapshot.timestamp,
    fingerprint,
    issueType,
    severity: finding.severity,
    title: finding.title,
    summary: finding.message,
    message: finding.message,
    scopeKind: namespace ? 'Namespace' : null,
    scopeName: namespace,
    objectKind,
    objectName,
    reason,
    findingId: finding.id,
    evidence: {
      source: 'snapshot_finding',
      namespace,
      objectKind,
      objectName,
      reason,
      findingId: finding.id
    },
    searchText: buildSearchText([finding.title, finding.message, cluster.name, namespace, objectKind, objectName, reason])
  };
}

function buildRestartObservation(
  cluster: KubernetesCluster,
  snapshot: ClusterSnapshot,
  pod: Record<string, unknown>,
  previousPods?: Map<string, Record<string, unknown>>
): TargetIssueObservationInput | null {
  const restartCount = getPodRestartCount(pod);
  if (restartCount < 10) return null;
  if (!previousPods) return null;
  const namespace = text(pod.namespace, 'default');
  const podName = text(pod.name, 'unknown');
  const { fingerprint, owner, containerName } = podFingerprint(cluster, namespace, pod, podName, 'pod-unhealthy', 'HighRestartCount');
  const previousPod = previousPods.get(`${namespace}/${podName}`);
  let previousRestartCount = previousPod ? getPodRestartCount(previousPod) : null;
  let matchedPreviousIdentity = Boolean(previousPod);
  if (!previousPod) {
    for (const candidate of previousPods.values()) {
      const candidateNamespace = text(candidate.namespace, 'default');
      if (candidateNamespace !== namespace) continue;
      const candidateOwner = inferControllerOwner(candidate);
      if (candidateOwner.kind !== owner.kind || candidateOwner.name !== owner.name) continue;
      if (containerName) {
        const hasMatchingContainer = toArray(candidate.containerStatuses).some((status) => text(status.name) === containerName);
        if (!hasMatchingContainer) continue;
      }
      previousRestartCount = getPodRestartCount(candidate);
      matchedPreviousIdentity = true;
      break;
    }
  }
  if (!matchedPreviousIdentity) return null;
  if (previousPod && previousRestartCount !== null && restartCount <= previousRestartCount) return null;
  const restartDelta = previousPod && previousRestartCount !== null ? restartCount - previousRestartCount : restartCount;
  const severity: TargetIssueSeverity = restartCount >= 50 ? 'critical' : 'warning';
  const title = owner.kind === 'Pod' ? `Pod ${podName} has repeated restarts` : `${owner.kind} ${owner.name} has repeated pod restarts`;
  const summary = `Latest snapshot reports ${restartDelta} new restart${restartDelta === 1 ? '' : 's'} for pod ${podName} in namespace ${namespace} (${restartCount} total).`;
  return {
    targetId: cluster.id,
    workspaceId: cluster.workspaceId,
    targetType: 'kubernetes',
    snapshotTs: snapshot.timestamp,
    fingerprint,
    issueType: 'kubernetes_pod_unhealthy',
    severity,
    title,
    summary,
    message: summary,
    scopeKind: 'Namespace',
    scopeName: namespace,
    objectKind: owner.kind,
    objectName: owner.name,
    reason: 'HighRestartCount',
    findingId: null,
    evidence: {
      source: 'restart_threshold',
      podName,
      namespace,
      owner,
      containerName,
      restartCount,
      previousRestartCount,
      restartDelta,
      reason: 'HighRestartCount'
    },
    searchText: buildSearchText([title, summary, cluster.name, namespace, owner.kind, owner.name, podName, containerName])
  };
}

export function deriveKubernetesIssueObservations(
  cluster: KubernetesCluster,
  snapshot: ClusterSnapshot,
  findings: SnapshotFindingListItem[],
  previousSnapshot?: ClusterSnapshot | null
): TargetIssueObservationInput[] {
  const pods = podByName(snapshot);
  const previousPods = previousSnapshot ? podByName(previousSnapshot) : undefined;
  const observations: TargetIssueObservationInput[] = [];
  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    if (finding.objectKind === 'Pod') {
      const namespace = finding.namespace || 'default';
      const podName = finding.objectName || 'unknown';
      const issueClass = classifyPodFinding(finding);
      if (issueClass) {
        observations.push(buildPodObservation(cluster, snapshot, finding, pods.get(`${namespace}/${podName}`), issueClass));
        continue;
      }
    }
    const generic = buildGenericKubernetesObservation(cluster, snapshot, finding);
    if (generic) observations.push(generic);
  }
  const resources = (snapshot.data.resources || {}) as Record<string, unknown>;
  for (const pod of toArray(resources.pods)) {
    const restartObservation = buildRestartObservation(cluster, snapshot, pod, previousPods);
    if (restartObservation) observations.push(restartObservation);
  }
  return observations;
}

function vmSeverity(value: unknown): TargetIssueSeverity {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'warning') return 'warning';
  return 'info';
}

function vmServiceIssueFingerprint(vmId: string, serviceName: string, activeState: string, subState: string): string {
  return [
    'vm',
    vmId,
    'systemd_service',
    normalizeFingerprintPart(serviceName),
    normalizeFingerprintPart(activeState),
    normalizeFingerprintPart(subState || activeState)
  ].join('|');
}

export function deriveVirtualMachineIssueObservations(
  vm: VirtualMachineTarget,
  snapshot: VirtualMachineSnapshot
): TargetIssueObservationInput[] {
  const data = snapshot.data || {};
  const observations: TargetIssueObservationInput[] = [];
  const serviceStates = new Map<string, Record<string, unknown>>();
  for (const service of toArray(data.degraded_services)) {
    const name = text(service.unit);
    const activeState = text(service.active_state, 'unknown');
    const subState = text(service.sub_state);
    const normalizedActiveState = activeState.toLowerCase();
    if (name) serviceStates.set(name, service);
    if (!name || !/failed|degraded/i.test(`${activeState} ${subState}`)) continue;
    const severity: TargetIssueSeverity = normalizedActiveState === 'failed' ? 'critical' : 'warning';
    const title = `Service ${name} is ${activeState}`;
    const summary = `Latest VM snapshot reports service ${name} as ${activeState}${subState ? ` (${subState})` : ''}.`;
    observations.push({
      targetId: vm.id,
      workspaceId: vm.workspaceId,
      targetType: 'virtual_machine',
      snapshotTs: snapshot.timestamp,
      fingerprint: vmServiceIssueFingerprint(vm.id, name, activeState, subState),
      issueType: 'vm_service_unhealthy',
      severity,
      title,
      summary,
      message: summary,
      scopeKind: null,
      scopeName: null,
      objectKind: 'systemd_service',
      objectName: name,
      reason: activeState,
      findingId: null,
      evidence: { source: 'vm_service_state', service },
      searchText: buildSearchText([title, summary, vm.name, name, activeState, subState])
    });
  }
  for (const finding of toArray(data.findings)) {
    const severity = vmSeverity(finding.severity);
    if (severity === 'info') continue;
    const objectKind = finding.unit ? 'systemd_service' : 'host';
    const objectName = text(finding.unit, text(finding.mount, vm.hostname || vm.name));
    const reason = text(finding.code, 'finding');
    const serviceLike = /service|systemd/i.test(objectKind);
    const issueType = serviceLike ? 'vm_service_unhealthy' : 'vm_host_finding';
    const title = text(finding.summary, 'VM issue');
    const summary = text(finding.summary, 'VM diagnostic issue');
    const matchingService = serviceLike ? serviceStates.get(objectName) : undefined;
    const activeState = text(matchingService?.active_state, reason);
    const subState = text(matchingService?.sub_state, activeState);
    observations.push({
      targetId: vm.id,
      workspaceId: vm.workspaceId,
      targetType: 'virtual_machine',
      snapshotTs: snapshot.timestamp,
      fingerprint: serviceLike
        ? vmServiceIssueFingerprint(vm.id, objectName, activeState, subState)
        : ['vm', vm.id, normalizeFingerprintPart(objectKind), normalizeFingerprintPart(objectName), normalizeFingerprintPart(reason)].join('|'),
      issueType,
      severity,
      title,
      summary,
      message: summary,
      scopeKind: null,
      scopeName: null,
      objectKind,
      objectName,
      reason,
      findingId: null,
      evidence: { source: 'vm_snapshot_finding', finding },
      searchText: buildSearchText([title, summary, vm.name, objectKind, objectName, reason])
    });
  }
  return observations;
}
