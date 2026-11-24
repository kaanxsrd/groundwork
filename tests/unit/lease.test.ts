import { describe, expect, test } from "bun:test";
import { renewEveryMs } from "../../src/internal/lease.ts";

describe("lease renewal", () => {
  test("renews three times per lease, even for the shortest one", () => {
    // A 1s lease used to be renewed every 1s, exactly when it ran out.
    expect(renewEveryMs(1_000)).toBe(333);
    expect(renewEveryMs(2_000)).toBe(666);
    expect(renewEveryMs(30_000)).toBe(10_000);
    for (const lease of [1_000, 1_500, 2_000, 60_000]) {
      expect(renewEveryMs(lease) * 3).toBeLessThanOrEqual(lease);
    }
  });
});
