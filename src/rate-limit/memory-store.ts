import { type Clock, systemClock } from "../internal/clock.ts";
import { GroundworkError } from "../internal/errors.ts";
import { capacityOf, fits, levelAt } from "./policy.ts";
import type { ConsumeInput, RateLimitStore, StoreState } from "./types.ts";

export interface MemoryStoreOptions {
  /**
   * Most subjects kept at once. When full, the least recently used subject is forgotten, which
   * resets its count. Defaults to 10,000.
   */
  readonly maxKeys?: number | undefined;
  /** Used when a check doesn't pass its own time. Defaults to the system clock. */
  readonly clock?: Clock | undefined;
}

interface Entry {
  used: number;
  updatedAt: number;
  expiresAt: number;
}

export interface MemoryStore extends RateLimitStore {
  readonly kind: "memory";
  /** How many subjects are held right now. */
  readonly size: number;
}

/**
 * Counters in this process's memory, with the same semantics as the Postgres and Redis stores.
 * Each instance enforces its own limits, so use it for tests, single-instance apps, or (as the
 * limiter does) as the fallback while the real store is down.
 */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new GroundworkError("invalid_config", "memory.maxKeys must be a positive integer.");
  }
  const clock = options.clock ?? systemClock;
  // A Map iterates in insertion order; re-inserting on every use makes the first key the least
  // recently used one, so eviction is O(1).
  const entries = new Map<string, Entry>();

  function consume(input: ConsumeInput): StoreState {
    const now = input.now ?? clock.now().getTime();
    const { policy, cost } = input;
    const existing = entries.get(input.key);
    const before: StoreState = { allowed: false, now, row: existing ?? null };
    const level = levelAt(policy, before);

    if (!fits(level, cost, capacityOf(policy))) {
      if (existing) {
        // A denied subject is the one most worth remembering: refresh its place, or a client
        // being rate-limited would drift to the front and be evicted, resetting its count.
        entries.delete(input.key);
        entries.set(input.key, existing);
      }
      return { allowed: false, now, row: existing ? { ...existing } : null };
    }

    let entry: Entry;
    if (policy.algorithm === "fixed-window") {
      const active = existing !== undefined && existing.expiresAt > now;
      entry =
        active && existing
          ? { used: existing.used + cost, updatedAt: now, expiresAt: existing.expiresAt }
          : { used: cost, updatedAt: now, expiresAt: now + policy.windowMs };
    } else {
      const used = level + cost;
      entry = { used, updatedAt: now, expiresAt: now + used / policy.ratePerMs };
    }

    entries.delete(input.key);
    entries.set(input.key, entry);
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return { allowed: true, now, row: { ...entry } };
  }

  return {
    kind: "memory",
    get size() {
      return entries.size;
    },
    consume: async (input) => consume(input),
    reset: async (key) => {
      entries.delete(key);
    },
    cleanup: async (nowArg) => {
      const now = nowArg ?? clock.now().getTime();
      let deleted = 0;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) {
          entries.delete(key);
          deleted++;
        }
      }
      return deleted;
    },
  };
}
