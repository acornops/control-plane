import { config } from '../config.js';
import { logger } from '../logger.js';
import { distributedRoutingEnabled } from './control-plane-coordination/common.js';
import { startAgentRpcBus, stopAgentRpcBus } from './control-plane-coordination/rpc-bus.js';
import { startRunEventFanout, stopRunEventFanout } from './control-plane-coordination/run-events.js';
import { startTargetChatActivityEventFanout, stopTargetChatActivityEventFanout } from './control-plane-coordination/chat-activity-events.js';

let started = false;

export { controlPlaneInstanceId, distributedRoutingEnabled } from './control-plane-coordination/common.js';
export {
  claimAgentOwner,
  clearAgentOwnerIfCurrent,
  getAgentOwner,
  isCurrentAgentOwner,
  refreshAgentOwner,
  type AgentOwnerRecord
} from './control-plane-coordination/agent-owner.js';
export { withRedisLease } from './control-plane-coordination/leases.js';
export {
  handleAgentRpcMessageForTests,
  registerAgentRpcHandler,
  requestRemoteAgentRpc,
  type AgentRpcRequest,
  type AgentRpcResponse
} from './control-plane-coordination/rpc-bus.js';
export {
  handleRunEventMessageForTests,
  publishRunEvents,
  registerRunEventHandler
} from './control-plane-coordination/run-events.js';
export {
  publishTargetChatActivityEvents,
  registerTargetChatActivityEventHandler
} from './control-plane-coordination/chat-activity-events.js';

export async function startControlPlaneCoordination(): Promise<void> {
  if (!distributedRoutingEnabled() || started) return;
  await Promise.all([startAgentRpcBus(), startRunEventFanout(), startTargetChatActivityEventFanout()]);
  started = true;
  logger.info({ instanceId: config.CONTROL_PLANE_INSTANCE_ID }, 'Started control-plane coordination');
}

export async function stopControlPlaneCoordination(): Promise<void> {
  await Promise.all([stopAgentRpcBus(), stopRunEventFanout(), stopTargetChatActivityEventFanout()]);
  started = false;
}
