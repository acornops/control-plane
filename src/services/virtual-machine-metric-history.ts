import type { TargetMetricHistoryPoint } from '../store/repository-target-metrics.js';

export interface VirtualMachineMetricHistoryPoint {
  timestamp: string;
  loadAverage1m: number | null;
  loadAverage5m: number | null;
  loadAverage15m: number | null;
  cpuUsagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  memoryFreeBytes: number | null;
  memoryUsedPercent: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedPercent: number | null;
  rootDiskUsedBytes: number | null;
  rootDiskTotalBytes: number | null;
  rootDiskUsedPercent: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function percentageNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0 || used < 0 || used > total) return null;
  return (used / total) * 100;
}

function hasValidUsage(used: number | null, total: number | null): boolean {
  return used !== null && total !== null && total > 0 && used <= total;
}

function usageBytes(value: Record<string, unknown> | null): { usedBytes: number | null; totalBytes: number | null } {
  const usedBytes = nonNegativeNumber(value?.usedBytes);
  const totalBytes = nonNegativeNumber(value?.totalBytes);
  return usedBytes !== null && totalBytes !== null && usedBytes > totalBytes
    ? { usedBytes: null, totalBytes }
    : { usedBytes, totalBytes };
}

function loadAverageAt(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  return nonNegativeNumber(value[index]);
}

function chooseRootDisk(disks: unknown): Record<string, unknown> | null {
  if (!Array.isArray(disks)) return null;
  const candidates = disks.map(record).filter((disk): disk is Record<string, unknown> => Boolean(disk));
  const validCandidates = candidates.filter((disk) => hasValidUsage(nonNegativeNumber(disk.usedBytes), nonNegativeNumber(disk.totalBytes)));
  const explicitRoot = validCandidates.find((disk) => disk.mount === '/' || disk.mountpoint === '/');
  if (explicitRoot) return explicitRoot;

  let highest: { disk: Record<string, unknown>; ratio: number } | null = null;
  for (const disk of validCandidates) {
    const usedBytes = nonNegativeNumber(disk.usedBytes) as number;
    const totalBytes = nonNegativeNumber(disk.totalBytes) as number;
    const ratio = usedBytes / totalBytes;
    if (!highest || ratio > highest.ratio) highest = { disk, ratio };
  }
  return highest?.disk || null;
}

export function mapVirtualMachineMetricHistoryPoint(
  point: Pick<TargetMetricHistoryPoint, 'timestamp' | 'metrics'>
): VirtualMachineMetricHistoryPoint {
  const memory = record(point.metrics.memory);
  const swap = record(point.metrics.swap);
  const rootDisk = chooseRootDisk(point.metrics.disks);
  const memoryUsage = usageBytes(memory);
  const swapBytes = usageBytes(swap);
  const memoryFreeBytes = nonNegativeNumber(memory?.freeBytes);
  const rootDiskUsedBytes = nonNegativeNumber(rootDisk?.usedBytes);
  const rootDiskTotalBytes = nonNegativeNumber(rootDisk?.totalBytes);

  return {
    timestamp: point.timestamp,
    loadAverage1m: loadAverageAt(point.metrics.loadAverage, 0),
    loadAverage5m: loadAverageAt(point.metrics.loadAverage, 1),
    loadAverage15m: loadAverageAt(point.metrics.loadAverage, 2),
    cpuUsagePercent: percentageNumber(point.metrics.cpuUsagePercent),
    memoryUsedBytes: memoryUsage.usedBytes,
    memoryTotalBytes: memoryUsage.totalBytes,
    memoryFreeBytes: memoryFreeBytes !== null && memoryUsage.totalBytes !== null && memoryFreeBytes > memoryUsage.totalBytes ? null : memoryFreeBytes,
    memoryUsedPercent: percent(memoryUsage.usedBytes, memoryUsage.totalBytes),
    swapUsedBytes: swapBytes.usedBytes,
    swapTotalBytes: swapBytes.totalBytes,
    swapUsedPercent: percent(swapBytes.usedBytes, swapBytes.totalBytes),
    rootDiskUsedBytes,
    rootDiskTotalBytes,
    rootDiskUsedPercent: percent(rootDiskUsedBytes, rootDiskTotalBytes)
  };
}
