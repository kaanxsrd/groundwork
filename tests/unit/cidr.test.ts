import { describe, expect, test } from "bun:test";
import { ipInBlocks, parseCidr, parseIp } from "../../src/internal/cidr.ts";

const blocks = (...texts: string[]) => texts.map(parseCidr);
const matches = (ip: string, ...texts: string[]) => ipInBlocks(ip, blocks(...texts));

describe("parseIp", () => {
  test.each([
    ["0.0.0.0"],
    ["255.255.255.255"],
    ["203.0.113.7"],
    [" 203.0.113.7 "],
    ["::"],
    ["::1"],
    ["2001:db8::1"],
    ["2001:DB8::1"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001"],
    ["1:2:3:4:5:6:7:8"],
    ["1::8"],
    ["::ffff:203.0.113.7"],
    ["64:ff9b::192.0.2.1"],
    ["fe80::1%eth0"],
    ["[2001:db8::1]"],
  ])("accepts %p", (ip) => {
    expect(parseIp(ip)).not.toBeNull();
  });

  test.each([
    [""],
    ["1.2.3"],
    ["1.2.3.4.5"],
    ["256.0.0.1"],
    ["010.0.0.1"],
    ["1.2.3.-4"],
    ["1.2.3.4/24"],
    ["a.b.c.d"],
    ["1:2:3:4:5:6:7:8:9"],
    ["1:2:3:4:5:6:7"],
    ["1::2::3"],
    [":::"],
    ["12345::"],
    ["g::1"],
    ["1.2.3.4::"],
    ["::1.2.3"],
    ["1:2:3:4:5:6:7::8"],
    ["localhost"],
  ])("rejects %p", (ip) => {
    expect(parseIp(ip)).toBeNull();
  });

  test("equivalent spellings parse to the same value", () => {
    expect(parseIp("2001:db8::1")).toBe(parseIp("2001:0DB8:0:0:0:0:0:0001"));
    expect(parseIp("203.0.113.7")).toBe(parseIp("::ffff:203.0.113.7"));
    expect(parseIp("203.0.113.7")).toBe(parseIp("::ffff:cb00:7107"));
    expect(parseIp("fe80::1%eth0")).toBe(parseIp("fe80::1"));
  });
});

describe("parseCidr", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["203.0.113.7/32", "203.0.113.7"],
    ["203.0.113.0/24", "203.0.113.0/24"],
    ["0.0.0.0/0", "0.0.0.0/0"],
    ["10.0.0.0/8", "10.0.0.0/8"],
    ["2001:DB8::/32", "2001:db8::/32"],
    ["2001:db8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["::/0", "::/0"],
    ["::1/128", "::1"],
    ["::ffff:203.0.113.0/120", "203.0.113.0/24"],
    ["::ffff:0:0/96", "0.0.0.0/0"],
  ])("normalises %p to %p", (input, text) => {
    expect(parseCidr(input).text).toBe(text);
  });

  test.each([
    ["10.0.0.1/8", "did you mean 10.0.0.0/8?"],
    ["2001:db8::1/32", "did you mean 2001:db8::/32?"],
    ["203.0.113.7/33", "at most 32"],
    ["::/129", "at most 128"],
    ["10.0.0.0/08", "prefix length must be a number"],
    ["10.0.0.0/-1", "prefix length must be a number"],
    ["10.0.0.0/8/8", "use one /"],
    ["not-an-ip", "not an IPv4 or IPv6 address"],
    ["", "not an IPv4 or IPv6 address"],
  ])("rejects %p", (input, message) => {
    expect(() => parseCidr(input)).toThrow(message);
  });
});

describe("ipInBlocks", () => {
  test("IPv4 boundaries", () => {
    expect(matches("203.0.113.0", "203.0.113.0/24")).toBe(true);
    expect(matches("203.0.113.255", "203.0.113.0/24")).toBe(true);
    expect(matches("203.0.112.255", "203.0.113.0/24")).toBe(false);
    expect(matches("203.0.114.0", "203.0.113.0/24")).toBe(false);
    expect(matches("10.0.0.2", "10.0.0.2/31")).toBe(true);
    expect(matches("10.0.0.3", "10.0.0.2/31")).toBe(true);
    expect(matches("10.0.0.4", "10.0.0.2/31")).toBe(false);
    expect(matches("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(matches("203.0.113.8", "203.0.113.7")).toBe(false);
  });

  test("/0 matches every address of its family, and only that family", () => {
    expect(matches("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(matches("255.255.255.255", "0.0.0.0/0")).toBe(true);
    expect(matches("2001:db8::1", "0.0.0.0/0")).toBe(false);
    expect(matches("2001:db8::1", "::/0")).toBe(true);
    expect(matches("1.2.3.4", "::/0")).toBe(true); // IPv4 lives inside IPv6's space
  });

  test("IPv6 boundaries and spellings", () => {
    expect(matches("2001:db8::", "2001:db8::/32")).toBe(true);
    expect(matches("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db8::/32")).toBe(true);
    expect(matches("2001:db9::", "2001:db8::/32")).toBe(false);
    expect(matches("2001:DB8:0:0:0:0:0:1", "2001:db8::1")).toBe(true);
    expect(matches("::1", "::1")).toBe(true);
    expect(matches("::2", "::1")).toBe(false);
    expect(matches("fe80::1%eth0", "fe80::/10")).toBe(true);
  });

  test("IPv4-mapped IPv6 addresses match IPv4 rules, and the other way round", () => {
    expect(matches("::ffff:203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(matches("::ffff:cb00:7107", "203.0.113.7")).toBe(true);
    expect(matches("203.0.113.7", "::ffff:203.0.113.0/120")).toBe(true);
    expect(matches("::ffff:203.0.114.7", "203.0.113.0/24")).toBe(false);
  });

  test("an address that doesn't parse never matches", () => {
    for (const ip of ["", "unknown", "203.0.113.7, 10.0.0.1", "010.0.0.1"]) {
      expect(matches(ip, "0.0.0.0/0", "::/0")).toBe(false);
    }
  });

  test("any of several blocks", () => {
    const rules = ["10.0.0.0/8", "192.168.1.10", "2001:db8::/48"];
    expect(matches("10.200.3.4", ...rules)).toBe(true);
    expect(matches("192.168.1.10", ...rules)).toBe(true);
    expect(matches("192.168.1.11", ...rules)).toBe(false);
    expect(matches("2001:db8:0:ffff::1", ...rules)).toBe(true);
    expect(matches("2001:db8:1::1", ...rules)).toBe(false);
    expect(ipInBlocks("10.0.0.1", [])).toBe(false);
  });
});
