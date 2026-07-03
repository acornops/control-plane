import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';

export function targetWebhookScope(targetId: string, targetType: TargetType): {
  clusterId?: string;
  targetId: string;
  targetType: TargetType;
} {
  return {
    ...(targetType === KUBERNETES_TARGET_TYPE ? { clusterId: targetId } : {}),
    targetId,
    targetType
  };
}
