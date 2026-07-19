function prometheusEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const labelText = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${prometheusEscape(labelValue)}"`)
    .join(',');
  return `${name}{${labelText}} ${Number.isFinite(value) ? value : 0}`;
}

export function increment(map: Map<string, number>, key: string, count = 1): void {
  map.set(key, (map.get(key) || 0) + count);
}
