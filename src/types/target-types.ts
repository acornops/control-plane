export const TARGET_TYPES = ['kubernetes', 'virtual_machine'] as const;
export type TargetType = typeof TARGET_TYPES[number];
export const KUBERNETES_TARGET_TYPE: TargetType = 'kubernetes';
export const VIRTUAL_MACHINE_TARGET_TYPE: TargetType = 'virtual_machine';
export const TARGET_TYPE_DISPLAY_LIST = TARGET_TYPES.join(', ');

export function isTargetType(value: string): value is TargetType {
  return TARGET_TYPES.includes(value as TargetType);
}
