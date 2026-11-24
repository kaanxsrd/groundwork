import { ipNetwork } from "../internal/cidr.ts";
import { GroundworkError } from "../internal/errors.ts";

export interface IpSubjectOptions {
  /**
   * How many leading bits of an IPv6 address make one subject: 32 to 128. Defaults to 64, the
   * smallest network a client usually gets, so one client can't escape a limit by switching
   * addresses inside it. 128 limits each address on its own.
   */
  readonly ipv6Prefix?: number | undefined;
}

const DEFAULT_IPV6_PREFIX = 64;

/**
 * The subject to rate-limit a client IP address by. IPv4 addresses are limited one by one. An
 * IPv6 address counts as its /64 network, because a single client usually holds a whole /64 and
 * can send every request from another address in it. IPv4-mapped IPv6 (`::ffff:203.0.113.7`)
 * counts as the IPv4 address.
 *
 * `null` and `undefined` come back as `null`, so it fits `clientIp(request)`, and a `null`
 * subject lets `withRateLimit` through without counting. Anything that isn't an IP address throws
 * `invalid_argument`, without repeating the value.
 *
 * ```ts
 * withRateLimit(signups, (request) => ipSubject(clientIp(request)), handleSignup);
 * await loginLimit.check(ipSubject("2001:db8:1:2:aaaa::1")); // "2001:db8:1:2::/64"
 * ```
 */
export function ipSubject(ip: string, options?: IpSubjectOptions): string;
export function ipSubject(ip: string | null | undefined, options?: IpSubjectOptions): string | null;
export function ipSubject(
  ip: string | null | undefined,
  options: IpSubjectOptions = {},
): string | null {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_argument", "ipSubject's options must be an object.");
  }
  const prefix = options.ipv6Prefix ?? DEFAULT_IPV6_PREFIX;
  if (!Number.isInteger(prefix) || prefix < 32 || prefix > 128) {
    throw new GroundworkError(
      "invalid_argument",
      "ipv6Prefix must be a whole number from 32 to 128, such as 64 or 56.",
    );
  }
  if (ip === null || ip === undefined) return null;
  const subject = typeof ip === "string" ? ipNetwork(ip, prefix) : null;
  if (subject === null) {
    // Subjects are kept out of errors and logs, so the value isn't repeated here.
    throw new GroundworkError(
      "invalid_argument",
      "ipSubject needs an IP address, such as the one clientIp(request) returns.",
    );
  }
  return subject;
}
