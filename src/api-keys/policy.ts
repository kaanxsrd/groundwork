import { type CidrBlock, parseCidr } from "../internal/cidr.ts";
import { GroundworkError } from "../internal/errors.ts";

/**
 * Canonical origin (`https://app.example.com`, lower-case, default port dropped), or `null` if
 * `value` isn't a bare http(s) origin. The literal `"null"` origin of sandboxed pages is `null`.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  return url.origin;
}

export function validateOrigins(values: unknown, label: string): string[] {
  if (!Array.isArray(values)) {
    throw new GroundworkError("invalid_argument", `${label} must be an array of origins.`);
  }
  if (values.length > 100)
    throw new GroundworkError("invalid_argument", `${label} allows at most 100 origins.`);
  const origins = values.map((value) => {
    const origin = typeof value === "string" ? normalizeOrigin(value) : null;
    if (origin === null) {
      throw new GroundworkError(
        "invalid_argument",
        `Invalid origin ${JSON.stringify(value)}: use a full origin such as "https://app.example.com".`,
      );
    }
    return origin;
  });
  return [...new Set(origins)];
}

export function validateIps(values: unknown, label: string): string[] {
  if (!Array.isArray(values)) {
    throw new GroundworkError(
      "invalid_argument",
      `${label} must be an array of IPs or CIDR blocks.`,
    );
  }
  if (values.length > 100)
    throw new GroundworkError("invalid_argument", `${label} allows at most 100 entries.`);
  const blocks = values.map((value) => {
    try {
      return parseCidr(value as string).text;
    } catch (error) {
      // Same message, but as a bad argument rather than bad configuration.
      throw new GroundworkError("invalid_argument", (error as Error).message);
    }
  });
  return [...new Set(blocks)];
}

/** Parsed allowlists are cached by their text, so verify doesn't re-parse them on every request. */
export function createIpCache(): (ips: readonly string[]) => CidrBlock[] {
  const cache = new Map<string, CidrBlock[]>();
  return (ips) => {
    const cacheKey = ips.join(",");
    let blocks = cache.get(cacheKey);
    if (!blocks) {
      // Stored values were validated on write; skip any that no longer parse rather than fail open.
      blocks = ips.flatMap((ip) => {
        try {
          return [parseCidr(ip)];
        } catch {
          return [];
        }
      });
      if (cache.size >= 1_000) cache.clear();
      cache.set(cacheKey, blocks);
    }
    return blocks;
  };
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/**
 * The presented key: `Authorization: Bearer <key>`, else `X-API-Key`. Anything else in
 * Authorization (Basic, say) counts as no key.
 */
export function extractKey(input: Request | Headers | string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") return input.trim() || null;
  const headers = input instanceof Headers ? input : input.headers;
  const authorization = headers.get("authorization");
  if (authorization !== null) {
    const match = BEARER.exec(authorization);
    if (match) return match[1] ?? null;
  }
  return headers.get("x-api-key")?.trim() || null;
}
