export interface CoordinationChildStatus {
  id: string;
  status: string;
  required: boolean;
}

export interface CoordinationCompletionFailure {
  code:
    | 'NO_DELEGATION_CREATED'
    | 'DELEGATIONS_STILL_ACTIVE'
    | 'REQUIRED_DELEGATION_FAILED'
    | 'NO_SPECIALIST_SUCCEEDED';
  message: string;
}

const TERMINAL_CHILD_STATUSES = new Set(['completed', 'failed', 'cancelled', 'needs_review']);

export function coordinationCompletionFailure(
  children: CoordinationChildStatus[]
): CoordinationCompletionFailure | undefined {
  if (children.length === 0) {
    return {
      code: 'NO_DELEGATION_CREATED',
      message: 'The coordinator did not create a specialist delegation.'
    };
  }
  if (children.some((child) => !TERMINAL_CHILD_STATUSES.has(child.status))) {
    return {
      code: 'DELEGATIONS_STILL_ACTIVE',
      message: 'One or more specialist delegations are still active.'
    };
  }
  const requiredFailure = children.find((child) => child.required && child.status !== 'completed');
  if (requiredFailure) {
    return {
      code: 'REQUIRED_DELEGATION_FAILED',
      message: `Required specialist delegation ${requiredFailure.id} ended with status ${requiredFailure.status}.`
    };
  }
  if (!children.some((child) => child.status === 'completed')) {
    return {
      code: 'NO_SPECIALIST_SUCCEEDED',
      message: 'No specialist delegation completed successfully.'
    };
  }
  return undefined;
}
