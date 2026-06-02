import { KubernetesCluster, ClusterSnapshot } from '../types/domain.js';

export type ResourceFamily = 'workloads' | 'network' | 'storage' | 'cluster';
export type SnapshotFindingSeverity = 'critical' | 'warning' | 'info';

export interface SnapshotResourceListItem {
  id: string;
  family: ResourceFamily;
  kind: string;
  name: string;
  namespace?: string;
  status?: string;
  node?: string;
  clusterId: string;
  clusterName: string;
  item: Record<string, unknown>;
}

export interface SnapshotFindingListItem {
  id: string;
  severity: SnapshotFindingSeverity;
  title: string;
  message: string;
  timestamp: number;
  namespace?: string;
  objectKind?: string;
  objectName?: string;
  reason?: string;
  clusterId: string;
  clusterName: string;
}

export interface SnapshotClusterSummary {
  resourceCount: number;
  findingCount: number;
  criticalFindingCount: number;
  namespaceCount: number;
  nodeCount: number;
  resourceFamilyCounts: Record<ResourceFamily, number>;
  resourceKindCounts: Record<string, number>;
}

export interface SnapshotResourceDerivedRow {
  clusterId: string;
  workspaceId: string;
  snapshotTs: string;
  resourceId: string;
  family: ResourceFamily;
  kind: string;
  namespace: string | null;
  name: string;
  status: string | null;
  node: string | null;
  needsAttention: boolean;
  sortKey: string;
  searchText: string;
  item: Record<string, unknown>;
}

export interface SnapshotFindingDerivedRow {
  clusterId: string;
  workspaceId: string;
  snapshotTs: string;
  findingId: string;
  severity: SnapshotFindingSeverity;
  severityRank: number;
  namespace: string | null;
  objectKind: string | null;
  objectName: string | null;
  title: string;
  message: string;
  reason: string | null;
  findingTs: string;
  searchText: string;
}

export interface SnapshotSummaryDerivedRow extends SnapshotClusterSummary {
  clusterId: string;
  workspaceId: string;
  snapshotTs: string;
}

export interface SnapshotDerivedRows {
  resources: SnapshotResourceDerivedRow[];
  findings: SnapshotFindingDerivedRow[];
  summary: SnapshotSummaryDerivedRow;
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

function nullable(value: string | undefined): string | null {
  return value && value.trim() ? value : null;
}

function searchText(fields: Array<unknown>): string {
  return fields
    .map((field) => String(field || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function resourceId(kind: string, item: Record<string, unknown>): string {
  return text(item.uid) || `${kind}/${text(item.namespace, 'default')}/${text(item.name, 'unknown')}`;
}

function inferResourceStatus(kind: string, item: Record<string, unknown>): string {
  if (kind === 'Node') {
    const ready = toArray((item.status as Record<string, unknown> | undefined)?.conditions).find((condition) => condition.type === 'Ready');
    return String(ready?.status || '').toLowerCase() === 'true' ? 'Ready' : 'NotReady';
  }
  if (kind === 'Pod') return text(item.phase, 'Unknown');
  if (kind === 'Namespace') return text(item.status, 'Unknown');
  if (kind === 'PersistentVolumeClaim') return text(item.status, 'Unknown');
  const replicas = Number(item.replicas ?? 0);
  const readyReplicas = Number(item.readyReplicas ?? 0);
  if (replicas > 0 && readyReplicas >= replicas) return 'Running';
  if (replicas > 0 && readyReplicas === 0) return 'Failed';
  return text(item.status, 'Unknown');
}

export function isResourceAttentionStatus(status: string | undefined): boolean {
  return /failed|crash|notready|pending|error/i.test(status || '');
}

function pushResources(
  output: SnapshotResourceListItem[],
  cluster: KubernetesCluster,
  resources: Record<string, unknown>,
  key: string,
  family: ResourceFamily,
  kind: string
): void {
  for (const item of toArray(resources[key])) {
    const name = text(item.name, 'unknown');
    output.push({
      id: resourceId(kind, item),
      family,
      kind,
      name,
      namespace: kind === 'Node' || kind === 'Namespace' ? undefined : text(item.namespace, 'default'),
      status: inferResourceStatus(kind, item),
      node: text(item.nodeName),
      clusterId: cluster.id,
      clusterName: cluster.name,
      item
    });
  }
}

export function buildResourceSortKey(resource: Pick<SnapshotResourceListItem, 'family' | 'kind' | 'namespace' | 'name' | 'id'>): string {
  return `${resource.family}:${resource.kind}:${resource.namespace || ''}:${resource.name}:${resource.id}`;
}

export function listSnapshotResources(cluster: KubernetesCluster, snapshot: ClusterSnapshot | null): SnapshotResourceListItem[] {
  const resources = (snapshot?.data?.resources || {}) as Record<string, unknown>;
  const output: SnapshotResourceListItem[] = [];
  pushResources(output, cluster, resources, 'deployments', 'workloads', 'Deployment');
  pushResources(output, cluster, resources, 'statefulSets', 'workloads', 'StatefulSet');
  pushResources(output, cluster, resources, 'daemonSets', 'workloads', 'DaemonSet');
  pushResources(output, cluster, resources, 'cronJobs', 'workloads', 'CronJob');
  pushResources(output, cluster, resources, 'jobs', 'workloads', 'Job');
  pushResources(output, cluster, resources, 'pods', 'workloads', 'Pod');
  pushResources(output, cluster, resources, 'services', 'network', 'Service');
  pushResources(output, cluster, resources, 'ingresses', 'network', 'Ingress');
  pushResources(output, cluster, resources, 'pvcs', 'storage', 'PersistentVolumeClaim');
  pushResources(output, cluster, resources, 'nodes', 'cluster', 'Node');
  pushResources(output, cluster, resources, 'namespaces', 'cluster', 'Namespace');
  return output.sort((left, right) => buildResourceSortKey(left).localeCompare(buildResourceSortKey(right)));
}

function buildSnapshotFinding(input: {
  id: string;
  severity: SnapshotFindingSeverity;
  title: string;
  message: string;
  timestamp: string | undefined;
  namespace?: string;
  objectKind: string;
  objectName: string;
  reason: string;
  cluster: KubernetesCluster;
}): SnapshotFindingListItem {
  return {
    id: `${input.cluster.id}:${input.id}`,
    severity: input.severity,
    title: input.title,
    message: input.message,
    timestamp: Date.parse(input.timestamp || '') || Date.now(),
    namespace: input.namespace,
    objectKind: input.objectKind,
    objectName: input.objectName,
    reason: input.reason,
    clusterId: input.cluster.id,
    clusterName: input.cluster.name
  };
}

function getPodWaitingReasons(pod: Record<string, unknown>): string[] {
  return toArray(pod.containerStatuses)
    .map((status) => {
      const state = (status.state || {}) as Record<string, unknown>;
      const waiting = (state.waiting || {}) as Record<string, unknown>;
      const terminated = (state.terminated || {}) as Record<string, unknown>;
      return text(waiting.reason) || text(terminated.reason);
    })
    .filter(Boolean);
}

function getPodRestartCount(pod: Record<string, unknown>): number {
  const statusRestartTotal = toArray(pod.containerStatuses).reduce(
    (total, status) => total + numberValue(status.restartCount),
    0
  );
  return Math.max(numberValue(pod.restartCount), statusRestartTotal);
}

function inferNodeStatus(node: Record<string, unknown>): string {
  const status = (node.status || {}) as Record<string, unknown>;
  const ready = toArray(status.conditions).find((condition) => condition.type === 'Ready');
  if (!ready) return 'Unknown';
  return String(ready.status || '').toLowerCase() === 'true' ? 'Ready' : 'NotReady';
}

function listSnapshotResourceFindings(cluster: KubernetesCluster, snapshot: ClusterSnapshot | null): SnapshotFindingListItem[] {
  const resources = (snapshot?.data?.resources || {}) as Record<string, unknown>;
  const timestamp = snapshot?.timestamp;
  const findings: SnapshotFindingListItem[] = [];

  for (const pod of toArray(resources.pods)) {
    const name = text(pod.name);
    if (!name) continue;
    const namespace = text(pod.namespace, 'default');
    const reasons = getPodWaitingReasons(pod);
    const normalizedReasons = reasons.map((reason) => reason.toLowerCase());
    const phase = text(pod.phase, 'Unknown');
    const normalizedPhase = phase.toLowerCase();
    const restartCount = getPodRestartCount(pod);
    const hasCriticalReason = normalizedReasons.some((reason) =>
      ['crashloopbackoff', 'imagepullbackoff', 'errimagepull', 'oomkilled', 'createcontainerconfigerror'].includes(reason)
    );

    if (hasCriticalReason || normalizedPhase === 'failed') {
      const reason = reasons[0] || phase;
      const restartDetail = restartCount > 0 ? ` Restart count: ${restartCount}.` : '';
      findings.push(buildSnapshotFinding({
        id: `snapshot-pod-${namespace}-${name}`,
        severity: 'critical',
        title: `Pod ${name} is unhealthy`,
        message: `Latest snapshot reports pod ${name} in namespace ${namespace} as ${reason}.${restartDetail}`,
        timestamp,
        namespace,
        objectKind: 'Pod',
        objectName: name,
        reason,
        cluster
      }));
      continue;
    }

    if (normalizedPhase === 'pending') {
      findings.push(buildSnapshotFinding({
        id: `snapshot-pod-${namespace}-${name}`,
        severity: 'warning',
        title: `Pod ${name} is pending`,
        message: `Latest snapshot reports pod ${name} in namespace ${namespace} as Pending.`,
        timestamp,
        namespace,
        objectKind: 'Pod',
        objectName: name,
        reason: 'Pending',
        cluster
      }));
    }
  }

  for (const node of toArray(resources.nodes)) {
    const name = text(node.name);
    if (!name) continue;
    const status = inferNodeStatus(node);
    if (status !== 'Ready') {
      findings.push(buildSnapshotFinding({
        id: `snapshot-node-${name}`,
        severity: status === 'NotReady' ? 'critical' : 'warning',
        title: `Node ${name} is ${status}`,
        message: `Latest snapshot reports node ${name} as ${status}.`,
        timestamp,
        objectKind: 'Node',
        objectName: name,
        reason: status,
        cluster
      }));
    }
  }

  for (const pvc of toArray(resources.pvcs)) {
    const name = text(pvc.name);
    if (!name) continue;
    const namespace = text(pvc.namespace, 'default');
    const status = text(pvc.status, 'Unknown');
    if (status !== 'Bound') {
      findings.push(buildSnapshotFinding({
        id: `snapshot-pvc-${namespace}-${name}`,
        severity: status === 'Lost' ? 'critical' : 'warning',
        title: `PVC ${name} is ${status}`,
        message: `Latest snapshot reports PVC ${name} in namespace ${namespace} as ${status}.`,
        timestamp,
        namespace,
        objectKind: 'PersistentVolumeClaim',
        objectName: name,
        reason: status,
        cluster
      }));
    }
  }

  for (const job of toArray(resources.jobs)) {
    const name = text(job.name);
    if (!name || numberValue(job.failed) <= 0) continue;
    const namespace = text(job.namespace, 'default');
    const failedCount = numberValue(job.failed);
    findings.push(buildSnapshotFinding({
      id: `snapshot-job-${namespace}-${name}`,
      severity: 'critical',
      title: `Job ${name} has failures`,
      message: `Latest snapshot reports ${failedCount} failed pod${failedCount === 1 ? '' : 's'} for job ${name}.`,
      timestamp,
      namespace,
      objectKind: 'Job',
      objectName: name,
      reason: 'Failed',
      cluster
    }));
  }

  return findings;
}

export function severityRank(severity: SnapshotFindingSeverity): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

export function listSnapshotFindings(cluster: KubernetesCluster, snapshot: ClusterSnapshot | null): SnapshotFindingListItem[] {
  const events = toArray((snapshot?.data?.events as unknown[]) || []);
  const eventFindings = events.map((event, index) => {
    const involved = (event.involvedObject || {}) as Record<string, unknown>;
    const signalText = `${text(event.type)} ${text(event.reason)} ${text(event.message)}`.toLowerCase();
    const severity: SnapshotFindingSeverity = [
      'crashloop',
      'failed',
      'failure',
      'unhealthy',
      'notready',
      'backoff',
      'oom',
      'evicted'
    ].some((token) => signalText.includes(token))
      ? 'critical'
      : text(event.type).toLowerCase() === 'warning'
        ? 'warning'
        : 'info';
    return {
      id: `${cluster.id}:${text(involved.namespace, 'default')}:${text(involved.name, 'resource')}:${index}`,
      severity,
      title: text(event.reason, 'Cluster Event'),
      message: text(event.message, 'No details provided.'),
      timestamp: Date.parse(text(event.lastTimestamp, new Date().toISOString())) || Date.now(),
      namespace: text(involved.namespace),
      objectKind: text(involved.kind),
      objectName: text(involved.name, 'resource'),
      reason: text(event.reason),
      clusterId: cluster.id,
      clusterName: cluster.name
    };
  });

  return [...listSnapshotResourceFindings(cluster, snapshot), ...eventFindings].sort((left, right) =>
    severityRank(left.severity) - severityRank(right.severity) || right.timestamp - left.timestamp || left.id.localeCompare(right.id)
  );
}

export function summarizeSnapshot(cluster: KubernetesCluster, snapshot: ClusterSnapshot | null): SnapshotClusterSummary {
  const resources = listSnapshotResources(cluster, snapshot);
  const findings = listSnapshotFindings(cluster, snapshot);
  return summarizeSnapshotItems(resources, findings);
}

export function summarizeSnapshotItems(
  resources: SnapshotResourceListItem[],
  findings: SnapshotFindingListItem[]
): SnapshotClusterSummary {
  const resourceFamilyCounts: Record<ResourceFamily, number> = {
    workloads: 0,
    network: 0,
    storage: 0,
    cluster: 0
  };
  const resourceKindCounts: Record<string, number> = {};
  for (const resource of resources) {
    resourceFamilyCounts[resource.family] += 1;
    resourceKindCounts[resource.kind] = (resourceKindCounts[resource.kind] || 0) + 1;
  }

  return {
    resourceCount: resources.length,
    findingCount: findings.length,
    criticalFindingCount: findings.filter((finding) => finding.severity === 'critical').length,
    namespaceCount: resources.filter((resource) => resource.kind === 'Namespace').length,
    nodeCount: resources.filter((resource) => resource.kind === 'Node').length,
    resourceFamilyCounts,
    resourceKindCounts
  };
}

export function toResourceDerivedRow(resource: SnapshotResourceListItem, snapshot: ClusterSnapshot): SnapshotResourceDerivedRow {
  const sortKey = buildResourceSortKey(resource);
  return {
    clusterId: resource.clusterId,
    workspaceId: snapshot.workspaceId,
    snapshotTs: snapshot.timestamp,
    resourceId: resource.id,
    family: resource.family,
    kind: resource.kind,
    namespace: nullable(resource.namespace),
    name: resource.name,
    status: nullable(resource.status),
    node: nullable(resource.node),
    needsAttention: isResourceAttentionStatus(resource.status),
    sortKey,
    searchText: searchText([resource.name, resource.namespace, resource.kind, resource.status, resource.node, resource.clusterName]),
    item: resource.item
  };
}

export function toFindingDerivedRow(finding: SnapshotFindingListItem, snapshot: ClusterSnapshot): SnapshotFindingDerivedRow {
  return {
    clusterId: finding.clusterId,
    workspaceId: snapshot.workspaceId,
    snapshotTs: snapshot.timestamp,
    findingId: finding.id,
    severity: finding.severity,
    severityRank: severityRank(finding.severity),
    namespace: nullable(finding.namespace),
    objectKind: nullable(finding.objectKind),
    objectName: nullable(finding.objectName),
    title: finding.title,
    message: finding.message,
    reason: nullable(finding.reason),
    findingTs: new Date(finding.timestamp).toISOString(),
    searchText: searchText([
      finding.title,
      finding.message,
      finding.clusterName,
      finding.namespace,
      finding.objectKind,
      finding.objectName,
      finding.reason
    ])
  };
}

export function toSummaryDerivedRow(
  cluster: KubernetesCluster,
  snapshot: ClusterSnapshot,
  summary: SnapshotClusterSummary
): SnapshotSummaryDerivedRow {
  return {
    clusterId: cluster.id,
    workspaceId: snapshot.workspaceId,
    snapshotTs: snapshot.timestamp,
    ...summary
  };
}

export function deriveSnapshotRows(cluster: KubernetesCluster, snapshot: ClusterSnapshot): SnapshotDerivedRows {
  const resources = listSnapshotResources(cluster, snapshot);
  const findings = listSnapshotFindings(cluster, snapshot);
  const summary = summarizeSnapshotItems(resources, findings);
  return {
    resources: resources.map((resource) => toResourceDerivedRow(resource, snapshot)),
    findings: findings.map((finding) => toFindingDerivedRow(finding, snapshot)),
    summary: toSummaryDerivedRow(cluster, snapshot, summary)
  };
}
