import { AsyncLocalStorage } from 'node:async_hooks';
import { getAgentOwner } from '../services/control-plane-coordination.js';
import { currentRequestSignal, serviceLifecycle } from '../services/service-lifecycle.js';
import { assertAgentExecutionAllowed } from './execution-authority.js';
import { AgentUnavailableError } from './types.js';

interface DispatchFence { deadline: number; signal?: AbortSignal; disarm: () => void }
const dispatchFence = new AsyncLocalStorage<DispatchFence>();

/** Called synchronously at the irreversible send/publication boundary, after every awaited check. */
export function beginAgentDispatch(): void {
  const fence = dispatchFence.getStore();
  if (!fence) return;
  if (performance.now() >= fence.deadline || fence.signal?.aborted || serviceLifecycle.isStopping) {
    throw new AgentUnavailableError();
  }
  fence.disarm();
}

export async function waitForOwnerHandoff<T>(clusterId: string, deadline: number, resume: () => Promise<T>): Promise<T> {
  const signal = currentRequestSignal();
  const end = Math.min(deadline, serviceLifecycle.drainDeadline);
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const disarm = () => {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  };
  const waiting = serviceLifecycle.track(() => dispatchFence.run({ deadline: end, signal, disarm }, async () => {
    let checkedAt = -Infinity;
    while (performance.now() < end && !serviceLifecycle.isStopping && !signal?.aborted) {
      if (performance.now() - checkedAt >= 1000) {
        await assertAgentExecutionAllowed();
        checkedAt = performance.now();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, end - performance.now()))));
      if (signal?.aborted || serviceLifecycle.isStopping || performance.now() >= end) break;
      const owner = await getAgentOwner(clusterId);
      if (signal?.aborted || serviceLifecycle.isStopping || performance.now() >= end) break;
      if (owner && owner.state !== 'draining') return resume();
    }
    throw new AgentUnavailableError();
  }));
  try {
    return await Promise.race([waiting, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AgentUnavailableError());
      timer = setTimeout(abort, Math.max(1, end - performance.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    disarm();
  }
}
