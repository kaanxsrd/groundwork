/**
 * How often a lease holder renews: three times per lease, so a renewal that's slow or misses
 * one beat still lands before the lease runs out. Leases are at least 1s, so this is at least
 * 333ms.
 */
export function renewEveryMs(leaseMs: number): number {
  return Math.floor(leaseMs / 3);
}
