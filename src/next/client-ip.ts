import { canonicalIp } from "../internal/cidr.ts";
import { GroundworkError } from "../internal/errors.ts";

/**
 * Which proxy header to take the client's IP from. Headers are trusted only when a proxy you
 * control sets them, so the default is `"none"`.
 *
 * - `"none"`: trust no header; `getClientIp` returns `null`. A bare `next start` passes on whatever
 *   `X-Forwarded-For` the client sent, so there is nothing safe to read without a proxy.
 * - `"vercel"`: `X-Real-IP`, which Vercel sets to the client's address (its docs list it as
 *   identical to the `X-Forwarded-For` it overwrites). Only use it on Vercel.
 * - `"cloudflare"`: `CF-Connecting-IP`. Only safe when your origin accepts traffic from Cloudflare
 *   alone; otherwise anyone can send the header straight to it.
 * - `{ header, hops }`: any other header. For a list such as `X-Forwarded-For`, `hops` is how many
 *   proxies you run in front of the app (default 1): each appends the address it received the
 *   request from, so the client is `hops` entries from the right. Entries further left were sent
 *   by the client and can be anything.
 */
export type TrustProxy =
  | "none"
  | "vercel"
  | "cloudflare"
  | { readonly header: string; readonly hops?: number | undefined };

export interface ClientIpOptions {
  /** Defaults to `"none"`. */
  readonly trustProxy?: TrustProxy | undefined;
}

interface Source {
  readonly header: string;
  readonly hops: number;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRESETS: Readonly<Record<"vercel" | "cloudflare", Source>> = {
  vercel: { header: "x-real-ip", hops: 1 },
  cloudflare: { header: "cf-connecting-ip", hops: 1 },
};

/** Checks a {@link TrustProxy} once, so a typo fails at startup instead of returning `null` forever. */
export function resolveTrustProxy(trustProxy: TrustProxy | undefined): Source | null {
  if (trustProxy === undefined || trustProxy === "none") return null;
  if (trustProxy === "vercel" || trustProxy === "cloudflare") return PRESETS[trustProxy];
  if (typeof trustProxy === "object" && trustProxy !== null) {
    const { header, hops = 1 } = trustProxy;
    if (typeof header !== "string" || !HEADER_NAME.test(header)) {
      throw new GroundworkError(
        "invalid_config",
        `trustProxy.header must be a header name, such as "x-forwarded-for".`,
      );
    }
    if (!Number.isInteger(hops) || hops < 1 || hops > 20) {
      throw new GroundworkError(
        "invalid_config",
        "trustProxy.hops must be the number of proxies in front of the app: an integer from 1 to 20.",
      );
    }
    return { header: header.toLowerCase(), hops };
  }
  throw new GroundworkError(
    "invalid_config",
    `trustProxy must be "none", "vercel", "cloudflare" or { header, hops }.`,
  );
}

/** One list entry as an address: drops a port (`203.0.113.7:4711`, `[2001:db8::1]:443`). */
function addressOf(entry: string): string | null {
  let text = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1] as string;
  else if (/^[\d.]+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  return canonicalIp(text);
}

export function clientIpFrom(headers: Headers, source: Source | null): string | null {
  if (source === null) return null;
  const value = headers.get(source.header);
  if (value === null) return null;
  const entries = value.split(",");
  const entry = entries[entries.length - source.hops];
  return entry === undefined ? null : addressOf(entry);
}

/**
 * The client's IP address in canonical form, or `null` when the trusted header is missing or
 * isn't an address. Never reads a header you didn't choose to trust.
 *
 * ```ts
 * getClientIp(request, { trustProxy: "vercel" }); // "203.0.113.7"
 * getClientIp(request, { trustProxy: { header: "x-forwarded-for", hops: 1 } });
 * ```
 */
export function getClientIp(
  input: Request | Headers,
  options: ClientIpOptions = {},
): string | null {
  const headers = input instanceof Headers ? input : input.headers;
  return clientIpFrom(headers, resolveTrustProxy(options.trustProxy));
}
