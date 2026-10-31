import { db } from '../infra/db.js';
import { projectWindowsCollectionStatus } from '../services/windows-vm-snapshot.js';
import { toIso } from './repository-mappers.js';
import type { TargetInventoryItemInput } from './repository-target-inventory.js';
import { mapVirtualMachineInventoryRow, type VirtualMachineInventoryRow } from './repository-virtual-machines.js';

/** Read one committed snapshot/read-model generation, including empty inventories. */
export async function listWindowsVirtualMachineInventory(workspaceId: string, vmId: string) {
  const result = await db.query(
    `SELECT s.target_id, s.workspace_id, s.snapshot_ts, s.data, summary.inventory_count,
       COALESCE((SELECT jsonb_agg(i ORDER BY i.sort_key ASC)
         FROM target_inventory_items i
         WHERE i.target_id = s.target_id AND i.workspace_id = s.workspace_id
           AND i.snapshot_ts = s.snapshot_ts), '[]'::jsonb) AS items
     FROM target_snapshots s
     LEFT JOIN target_snapshot_summaries summary
       ON summary.target_id = s.target_id AND summary.workspace_id = s.workspace_id
       AND summary.snapshot_ts = s.snapshot_ts
     WHERE s.target_id = $1 AND s.workspace_id = $2`, [vmId, workspaceId]
  );
  const row = result.rows[0];
  if (!row) return { items: [], collectionStatus: null };
  const items: TargetInventoryItemInput[] = row.items.map((item: VirtualMachineInventoryRow) =>
    mapVirtualMachineInventoryRow({ ...item, snapshot_ts: row.snapshot_ts }));
  const collectionStatus = row.inventory_count !== null && Number(row.inventory_count) === items.length
    ? projectWindowsCollectionStatus({ targetId: row.target_id, workspaceId: row.workspace_id,
      timestamp: toIso(row.snapshot_ts)!, data: row.data })
    : null;
  return { items, collectionStatus };
}
