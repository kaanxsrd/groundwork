import { hmacSha256, randomBase64Url, randomHex } from "../internal/crypto.ts";
import { GroundworkError } from "../internal/errors.ts";

/**
 * Key format: `<namespace>_<prefix>_<secret>[<checksum>]`
 *
 * - `prefix`: 12 hex characters (6 random bytes). Not secret; stored to tell keys apart.
 * - `secret`: 43 base64url characters (32 random bytes).
 * - `checksum`: 6 base62 characters of CRC32 over everything before it. It isn't a secret:
 *   it lets typos be rejected without a database lookup, and lets secret scanners confirm a
 *   match. Keys without it (such as vante.app's) are still accepted.
 *
 * Only an HMAC of `<namespace>_<prefix>_<secret>` is stored, so a key verifies the same with or
 * without its checksum.
 */

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;
const PREFIX_LENGTH = PREFIX_BYTES * 2;
const SECRET_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (IEEE), as zlib computes it. Node only gained zlib.crc32 in 22.2. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function checksumOf(body: string): string {
  let value = crc32(body);
  let out = "";
  for (let i = 0; i < CHECKSUM_LENGTH; i++) {
    out = BASE62[value % 62] + out;
    value = Math.floor(value / 62);
  }
  return out;
}

export function validateNamespace(namespace: unknown): string {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new GroundworkError(
      "invalid_config",
      `Invalid API key namespace ${JSON.stringify(namespace)}: use 2 to 16 lower-case letters and digits, starting with a letter (for example "vnt").`,
    );
  }
  return namespace;
}

export interface GeneratedKey {
  /** The full key, shown to the user once. */
  readonly key: string;
  /** What is hashed: the key without its checksum. */
  readonly body: string;
  readonly prefix: string;
}

export function generateKey(namespace: string, checksum: boolean): GeneratedKey {
  const prefix = randomHex(PREFIX_BYTES);
  const body = `${namespace}_${prefix}_${randomBase64Url(SECRET_BYTES)}`;
  return { key: checksum ? `${body}${checksumOf(body)}` : body, body, prefix };
}

export interface ParsedKey {
  readonly body: string;
  readonly prefix: string;
}

/**
 * Parses a presented key. Returns `null` for anything malformed, including a wrong checksum, so
 * the caller can reject it without a database lookup. Fixed-length patterns only: no input can
 * make this slow.
 */
export function parseKey(raw: string, namespace: string): ParsedKey | null {
  const bodyLength = namespace.length + 1 + PREFIX_LENGTH + 1 + SECRET_LENGTH;
  if (raw.length !== bodyLength && raw.length !== bodyLength + CHECKSUM_LENGTH) return null;
  if (!raw.startsWith(`${namespace}_`)) return null;
  const body = raw.slice(0, bodyLength);
  const prefix = body.slice(namespace.length + 1, namespace.length + 1 + PREFIX_LENGTH);
  const separator = body[namespace.length + 1 + PREFIX_LENGTH];
  const secret = body.slice(bodyLength - SECRET_LENGTH);
  if (!/^[0-9a-f]{12}$/.test(prefix) || separator !== "_" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    return null;
  }
  if (raw.length > bodyLength && raw.slice(bodyLength) !== checksumOf(body)) return null;
  return { body, prefix };
}

/** The stored hash: hex HMAC-SHA256 of the key body under the API-key subkey. */
export function hashKey(subkey: Uint8Array, body: string): string {
  return hmacSha256(subkey, body).toString("hex");
}

/** `vnt_3f9ca0c44a15`: what UIs and logs show instead of a key. */
export const displayPrefix = (namespace: string, prefix: string): string =>
  `${namespace}_${prefix}`;

/**
 * Replaces any key in `text` (a URL, a log line) with its display prefix, so a key pasted into
 * the wrong place doesn't end up in your logs.
 */
export function redactKeys(text: string, namespace: string): string {
  const pattern = new RegExp(
    `${namespace}_([0-9a-f]{${PREFIX_LENGTH}})_[A-Za-z0-9_-]{${SECRET_LENGTH}}(?:[0-9A-Za-z]{${CHECKSUM_LENGTH}})?`,
    "g",
  );
  return text.replace(pattern, (_, prefix: string) => `${namespace}_${prefix}_[redacted]`);
}
