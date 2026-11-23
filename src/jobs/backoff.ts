/**
 * Exponential backoff with full jitter (AWS's "full jitter"): a random wait between 0 and
 * `min(maxMs, baseMs * 2^(attempt - 1))`. Spreading retries out keeps a burst of failures from
 * retrying in lockstep.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

/**
 * A fixed retry ladder: after the `attempt`-th failure, wait `delaysMs[attempt - 1]`. Once the
 * ladder runs out, its last step repeats. No jitter: the delays are what the app asked for.
 */
export function ladderDelayMs(attempt: number, delaysMs: readonly number[]): number {
  const step = Math.min(Math.max(attempt, 1), delaysMs.length) - 1;
  return delaysMs[step] ?? 0;
}
