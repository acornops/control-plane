import type { AgentConnection } from './types.js';

// Keep the latest accepted attempt through completion. An older waiter must not
// regain socket-close authority after its replacement publishes or fails.
// Weak keys retain no socket after the transport and its work are released.
const attempts = new WeakMap<AgentConnection['ws'], string>();

export function recordVirtualMachineSocketAttempt(conn: AgentConnection): void {
  attempts.set(conn.ws, conn.connectionId);
}

export function ownsVirtualMachineSocket(conn: AgentConnection): boolean {
  const current = attempts.get(conn.ws);
  return current === undefined || current === conn.connectionId;
}
