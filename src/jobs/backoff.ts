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
