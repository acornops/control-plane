import { AsyncLocalStorage } from 'node:async_hooks';
import { getAgentOwner } from '../services/control-plane-coordination.js';
import { currentRequestSignal, serviceLifecycle } from '../services/service-lifecycle.js';
import { assertAgentExecutionAllowed } from './execution-authority.js';
import { AgentUnavailableError } from './types.js';

interface DispatchFence { deadline: number; signal?: AbortSignal; arm: () => void; disarm: () => void; closed: boolean }
const dispatchFence = new AsyncLocalStorage<DispatchFence>();

/** Called synchronously at the irreversible send/publication boundary, after every awaited check. */
export function beginAgentDispatch(): void {
  const fence = dispatchFence.getStore();
  if (!fence) return;
  if (fence.closed || performance.now() >= fence.deadline || fence.signal?.aborted || serviceLifecycle.isStopping) {
    throw new AgentUnavailableError();
  }
  fence.disarm();
}

async function pollOwnerHandoff<T>(clusterId: string, fence: DispatchFence, resume: () => Promise<T>): Promise<T> {
  const { signal } = fence;
  let checkedAt = -Infinity;
  while (!fence.closed && performance.now() < fence.deadline && !serviceLifecycle.isStopping && !signal?.aborted) {
    if (performance.now() - checkedAt >= 1000) {
      await assertAgentExecutionAllowed();
      checkedAt = performance.now();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, fence.deadline - performance.now()))));
    if (fence.closed || signal?.aborted || serviceLifecycle.isStopping || performance.now() >= fence.deadline) break;
    const owner = await getAgentOwner(clusterId);
    if (fence.closed || signal?.aborted || serviceLifecycle.isStopping || performance.now() >= fence.deadline) break;
    if (owner && owner.state !== 'draining') return resume();
  }
  throw new AgentUnavailableError();
}

export async function waitForOwnerHandoff<T>(clusterId: string, deadline: number, resume: () => Promise<T>): Promise<T> {
  // Recursive owner changes belong to one logical dispatch and share its watchdog.
  const inherited = dispatchFence.getStore();
  if (inherited) {
    inherited.deadline = Math.min(inherited.deadline, deadline, serviceLifecycle.drainDeadline);
    inherited.arm();
    return pollOwnerHandoff(clusterId, inherited, resume);
  }
  const signal = currentRequestSignal();
  let timer: NodeJS.Timeout | undefined;
  let armedDeadline: number | undefined;
  let abort: (() => void) | undefined;
  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (abort) signal?.removeEventListener('abort', abort);
  };
  const fence: DispatchFence = {
    deadline: Math.min(deadline, serviceLifecycle.drainDeadline), signal, disarm, closed: false,
    arm: () => {
      if (fence.closed || signal?.aborted || serviceLifecycle.isStopping || performance.now() >= fence.deadline) {
        disarm();
        abort?.();
        return;
      }
      // Rearm after a safe owner rejection, without moving an already-live timer.
      if (timer && armedDeadline === fence.deadline) return;
      disarm();
      armedDeadline = fence.deadline;
      timer = setTimeout(() => abort?.(), Math.max(1, fence.deadline - performance.now()));
      if (abort) signal?.addEventListener('abort', abort, { once: true });
    }
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    abort = () => { fence.closed = true; reject(new AgentUnavailableError()); };
    fence.arm();
  });
  const waiting = serviceLifecycle.track(() => dispatchFence.run(fence, () => pollOwnerHandoff(clusterId, fence, resume)));
  try {
    return await Promise.race([waiting, timeout]);
  } finally {
    fence.closed = true;
    disarm();
  }
}
