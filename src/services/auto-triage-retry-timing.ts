export function autoTriageBlockedBackoffDelaySeconds(attemptCount: number): number {
  return Math.min(15 * 60, 30 * (2 ** Math.max(0, attemptCount - 1)));
}

export function autoTriageBlockedBackoff(attemptCount: number): string {
  const delaySeconds = autoTriageBlockedBackoffDelaySeconds(attemptCount);
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}
