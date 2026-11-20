import { GroundworkError } from "./errors.ts";

/**
 * IPv4 and IPv6 addresses and CIDR blocks, compared as 128-bit numbers. IPv4 is mapped into
 * IPv6 (`::ffff:a.b.c.d`), so an IPv4 rule also matches the IPv4-mapped form some servers report
 * (`::ffff:203.0.113.7`), and the other way round.
 */

const IPV4_MAPPED = 0xffffn << 32n;
const ALL_ONES = (1n << 128n) - 1n;

export interface CidrBlock {
  /** Canonical text: `203.0.113.0/24`, `2001:db8::/32`. A single address keeps no suffix. */
  readonly text: string;
  readonly network: bigint;
  readonly mask: bigint;
}

function parseIPv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // No leading zeros: "010" is octal to some parsers and decimal to others.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIPv6(input: string): bigint | null {
  // Zone ids ("fe80::1%eth0") name an interface on this host; they don't change the address.
  const text = input.split("%")[0] ?? "";
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (part: string): bigint[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: bigint[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? "";
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIPv4(piece);
        if (v4 === null) return null;
        groups.push(v4 >> 16n, v4 & 0xffffn);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        groups.push(BigInt(`0x${piece}`));
      } else {
        return null;
      }
    }
    return groups;
  };

  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  // An embedded IPv4 address may only come last.
  if (halves.length === 2 && (halves[0] ?? "").includes(".")) return null;

  const groups = [...head, ...Array(8 - head.length - tail.length).fill(0n), ...tail];
  return groups.reduce((value: bigint, group: bigint) => (value << 16n) | group, 0n);
}

/** Parses an address to 128 bits (IPv4 mapped into IPv6), or returns `null` if it isn't one. */
export function parseIp(text: string): bigint | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.includes(":")) return parseIPv6(trimmed.replace(/^\[|\]$/g, ""));
  const v4 = parseIPv4(trimmed);
  return v4 === null ? null : IPV4_MAPPED | v4;
}

const isMappedV4 = (value: bigint) => value >> 32n === 0xffffn;

/**
 * An address in canonical form (IPv4 dotted, IPv6 per RFC 5952, IPv4-mapped IPv6 as IPv4), or
 * `null` if `text` isn't an address.
 */
export function canonicalIp(text: string): string | null {
  const value = parseIp(text);
  return value === null ? null : formatIp(value);
}

function formatIp(value: bigint): string {
  if (isMappedV4(value)) {
    const v4 = value & 0xffffffffn;
    return [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join(".");
  }
  const groups = Array.from({ length: 8 }, (_, i) => (value >> BigInt(112 - 16 * i)) & 0xffffn);
  // RFC 5952: compress the longest run of two or more zero groups, the first if tied.
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0n) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0n) j++;
    if (j - i > best.length && j - i >= 2) best = { start: i, length: j - i };
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (best.start === -1) return hex.join(":");
  const left = hex.slice(0, best.start).join(":");
  const right = hex.slice(best.start + best.length).join(":");
  return `${left}::${right}`;
}

/**
 * Parses `203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32` or `::1`. Throws `invalid_config` for
 * anything else, including a block with host bits set (`10.0.0.1/8`), which is usually a typo.
 */
export function parseCidr(input: string): CidrBlock {
  const fail = (why: string): never => {
    throw new GroundworkError(
      "invalid_config",
      `Invalid IP or CIDR ${JSON.stringify(input)}: ${why}.`,
    );
  };
  if (typeof input !== "string") fail("it must be a string");
  const [addressText = "", prefixText, extra] = input.trim().split("/");
  if (extra !== undefined) fail("use one /");
  const address = parseIp(addressText);
  if (address === null) fail("not an IPv4 or IPv6 address");
  const value = address as bigint;
  const v4 = !addressText.includes(":") && isMappedV4(value);
  const max = v4 ? 32 : 128;
  let prefix = max;
  if (prefixText !== undefined) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) fail("the prefix length must be a number");
    prefix = Number(prefixText);
    if (prefix > max) fail(`the prefix length must be at most ${max}`);
  }
  const bits = v4 ? 96 + prefix : prefix;
  const mask = bits === 0 ? 0n : (ALL_ONES << BigInt(128 - bits)) & ALL_ONES;
  const network = value & mask;
  if (network !== value) {
    fail(`host bits are set; did you mean ${formatIp(network)}/${prefix}?`);
  }
  // Canonical text: IPv4 notation whenever the block lies inside the IPv4-mapped range.
  const asV4 = isMappedV4(network) && bits >= 96;
  const shown = asV4 ? bits - 96 : bits;
  const text = shown === (asV4 ? 32 : 128) ? formatIp(network) : `${formatIp(network)}/${shown}`;
  return { text, network, mask };
}

/** Whether `ip` (a single address) falls inside any of `blocks`. An unparseable ip never does. */
export function ipInBlocks(ip: string, blocks: readonly CidrBlock[]): boolean {
  const value = parseIp(ip);
  if (value === null) return false;
  return blocks.some((block) => (value & block.mask) === block.network);
}
