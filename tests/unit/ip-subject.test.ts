import { describe, expect, test } from "bun:test";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { createRateLimiter, ipSubject, memoryStore } from "../../src/rate-limit/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

describe("ipSubject", () => {
  test("limits IPv4 addresses one by one", () => {
    expect(ipSubject("203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(ipSubject("203.0.113.8")).not.toBe(ipSubject("203.0.113.7"));
  });

  test("counts an IPv6 address as its /64, in one spelling", () => {
    const subject = "2001:db8:1:2::/64";
    for (const ip of [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd",
      "[2001:db8:1:2::9]",
      "2001:db8:1:2::9%eth0",
    ]) {
      expect(ipSubject(ip)).toBe(subject);
    }
    expect(ipSubject("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(ipSubject("::1")).toBe("::/64");
  });

  test("counts IPv4-mapped IPv6 as the IPv4 address, never as one shared /64", () => {
    // A hand-written bucketing turned every ::ffff:… address into 0000:0000:0000:0000::/64,
    // so one client could use up a limit for all of them.
    expect(ipSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(ipSubject("::ffff:203.0.113.8")).toBe("203.0.113.8");
  });

  test("ipv6Prefix chooses how much of an IPv6 address is one subject", () => {
    expect(ipSubject("2001:db8:1:2a::1", { ipv6Prefix: 56 })).toBe("2001:db8:1::/56");
    expect(ipSubject("2001:db8:1:2a::1", { ipv6Prefix: 48 })).toBe("2001:db8:1::/48");
    expect(ipSubject("2001:db8::1", { ipv6Prefix: 128 })).toBe("2001:db8::1/128");
    expect(ipSubject("2001:db8::2", { ipv6Prefix: 128 })).toBe("2001:db8::2/128");
    expect(ipSubject("2001:db8:1:2:3:4:5:6", { ipv6Prefix: 65 })).toBe("2001:db8:1:2::/65");
    expect(ipSubject("2001:db8:1:2:8000::1", { ipv6Prefix: 65 })).toBe("2001:db8:1:2:8000::/65");
    // It never changes IPv4.
    expect(ipSubject("203.0.113.7", { ipv6Prefix: 48 })).toBe("203.0.113.7");
  });

  test("passes null and undefined through, as clientIp's null", () => {
    expect(ipSubject(null)).toBeNull();
    expect(ipSubject(undefined)).toBeNull();
  });

  test("throws for anything that isn't an address, without repeating it", () => {
    for (const bad of ["", "localhost", "203.0.113.7, 10.0.0.1", "203.0.113.7:8080", "1.2.3"]) {
      let thrown: unknown;
      try {
        ipSubject(bad);
      } catch (error) {
        thrown = error;
      }
      expect(isGroundworkError(thrown) && thrown.code).toBe("invalid_argument");
      if (bad !== "") expect((thrown as Error).message).not.toContain(bad);
    }
    expect(() => ipSubject(42 as never)).toThrow(/needs an IP address/);
  });

  test("checks ipv6Prefix, even for a null address", () => {
    for (const ipv6Prefix of [0, 31, 129, 64.5, Number.NaN, "64" as never]) {
      expect(() => ipSubject(null, { ipv6Prefix })).toThrow(/ipv6Prefix must be a whole number/);
    }
    expect(() => ipSubject("::1", null as never)).toThrow(/options must be an object/);
  });

  test("one client rotating through its /64 shares one limit", async () => {
    const clock = createTestClock();
    const rule = createRateLimiter({
      store: memoryStore({ clock }),
      secret: TEST_SECRET,
      clock,
    }).rule({ name: "login:ip", limit: 3, window: "15m" });
    const results = [];
    for (let i = 1; i <= 4; i++) {
      results.push((await rule.check(ipSubject(`2001:db8:1:2::${i.toString(16)}`))).allowed);
    }
    expect(results).toEqual([true, true, true, false]);
    // A neighbour in another /64 has its own limit.
    expect((await rule.check(ipSubject("2001:db8:1:3::1"))).allowed).toBe(true);
  });
});
