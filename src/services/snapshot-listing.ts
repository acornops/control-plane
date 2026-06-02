import {
  isResourceAttentionStatus
} from './snapshot-derived-data.js';
import type {
  SnapshotFindingListItem,
  SnapshotResourceListItem
} from './snapshot-derived-data.js';
import { containsSearchText, encodeCursor, PagedResult } from '../utils/pagination.js';

export {
  buildResourceSortKey,
  deriveSnapshotRows,
  isResourceAttentionStatus,
  listSnapshotFindings,
  listSnapshotResources,
  severityRank,
  summarizeSnapshot,
  summarizeSnapshotItems,
  toFindingDerivedRow,
  toResourceDerivedRow,
  toSummaryDerivedRow
} from './snapshot-derived-data.js';

export type {
  SnapshotClusterSummary,
  SnapshotFindingDerivedRow,
  SnapshotFindingListItem,
  SnapshotResourceDerivedRow,
  SnapshotResourceListItem,
  SnapshotSummaryDerivedRow,
  ResourceFamily
} from './snapshot-derived-data.js';

export function filterResources(
  items: SnapshotResourceListItem[],
  filters: { q?: string; family?: string; kind?: string; namespace?: string; health?: string }
): SnapshotResourceListItem[] {
  return items.filter((item) => {
    if (filters.family && item.family !== filters.family) return false;
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.namespace && item.namespace !== filters.namespace) return false;
    if (filters.health === 'attention' && !isResourceAttentionStatus(item.status)) return false;
    if (filters.health === 'healthy' && isResourceAttentionStatus(item.status)) return false;
    return containsSearchText([item.name, item.namespace, item.kind, item.status, item.node, item.clusterName], filters.q || '');
  });
}

export function filterFindings(
  items: SnapshotFindingListItem[],
  filters: { q?: string; severity?: string; namespace?: string; clusterId?: string }
): SnapshotFindingListItem[] {
  return items.filter((item) => {
    if (filters.severity && item.severity !== filters.severity) return false;
    if (filters.namespace && item.namespace !== filters.namespace) return false;
    if (filters.clusterId && item.clusterId !== filters.clusterId) return false;
    return containsSearchText(
      [item.title, item.message, item.clusterName, item.namespace, item.objectKind, item.objectName, item.reason],
      filters.q || ''
    );
  });
}

export function pageInMemory<T>(
  items: T[],
  limit: number,
  cursor: { offset?: number } | null,
  signature: string
): PagedResult<T> {
  const offset = Math.max(0, Number(cursor?.offset || 0));
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor: nextOffset < items.length ? encodeCursor({ signature, offset: nextOffset }) : undefined
  };
}
