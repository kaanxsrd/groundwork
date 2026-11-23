import {
  createHmac,
  hkdfSync,
  timingSafeEqual as nodeTimingSafeEqual,
  randomBytes,
} from "node:crypto";
import { GroundworkError } from "./errors.ts";

/** The app secret, as a string (UTF-8) or raw bytes. It must be at least 32 bytes long. */
export type Secret = string | Uint8Array;

/**
 * The secret, or a function that returns it. A function is called on first use (the first check,
 * key hash or idempotency claim), so code that only cleans up, prunes or runs jobs never needs
 * it, and the environment can be read after `next build`.
 */
export type SecretSource = Secret | (() => Secret);

/** What a derived subkey is used for. Each module gets its own key, so one can never stand in for another. */
export type KeyPurpose = "rate-limit" | "api-keys" | "idempotency";

export const KEY_PURPOSES: readonly KeyPurpose[] = ["rate-limit", "api-keys", "idempotency"];

/** 256 bits. Generate one with `openssl rand -base64 32`. */
export const MIN_SECRET_BYTES = 32;

/** Length of each derived subkey in bytes (the SHA-256 output size). */
export const SUBKEY_BYTES = 32;

// These strings are part of the storage format: changing them changes every stored hash,
// which would invalidate every API key. Bump the version only together with a migration path.
const HKDF_SALT = "groundwork/v1";
const hkdfInfo = (purpose: KeyPurpose): string => `groundwork/v1/${purpose}`;

export type Subkeys = Readonly<Record<KeyPurpose, Buffer>>;

function secretBytes(secret: Secret): Buffer {
  if (typeof secret !== "string" && !(secret instanceof Uint8Array)) {
    throw new GroundworkError("invalid_config", "secret must be a string or a Uint8Array.");
  }
  const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (bytes.length < MIN_SECRET_BYTES) {
    // Never echo the secret, not even its length: only the requirement.
    throw new GroundworkError(
      "invalid_config",
      `secret must be at least ${MIN_SECRET_BYTES} bytes. Generate one with: openssl rand -base64 32`,
    );
  }
  return bytes;
}

/** Derives the subkey for one purpose with HKDF-SHA256 (RFC 5869). */
export function deriveSubkey(secret: Secret, purpose: KeyPurpose): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secretBytes(secret), HKDF_SALT, hkdfInfo(purpose), SUBKEY_BYTES),
  );
}

/**
 * The subkey for one purpose, derived once. A plain secret is checked and derived now; a
 * function is called, checked and derived on the first call, so a bad secret fails then.
 */
export function lazySubkey(source: SecretSource, purpose: KeyPurpose): () => Buffer {
  if (typeof source !== "function") {
    const key = deriveSubkey(source, purpose);
    return () => key;
  }
  let key: Buffer | undefined;
  return () => {
    key ??= deriveSubkey(source(), purpose);
    return key;
  };
}

/** Throws now for a plain secret that's too short; a function is checked on first use. */
export function checkSecretSource(source: SecretSource): void {
  if (typeof source !== "function") secretBytes(source);
}

/** Derives every subkey once, so hot paths never repeat the HKDF work. */
export function deriveSubkeys(secret: Secret): Subkeys {
  const ikm = secretBytes(secret);
  const entries = KEY_PURPOSES.map(
    (purpose) =>
      [
        purpose,
        Buffer.from(hkdfSync("sha256", ikm, HKDF_SALT, hkdfInfo(purpose), SUBKEY_BYTES)),
      ] as const,
  );
  return Object.freeze(Object.fromEntries(entries) as Record<KeyPurpose, Buffer>);
}

/** HMAC-SHA256 of one message. */
export function hmacSha256(key: Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * HMAC-SHA256 over several parts with an unambiguous encoding: each part is prefixed with its
 * byte length (strings as UTF-8), so `["ab", "c"]` and `["a", "bc"]` never produce the same digest.
 */
export function hmacSha256Parts(key: Uint8Array, parts: readonly (string | Uint8Array)[]): Buffer {
  const hmac = createHmac("sha256", key);
  const length = Buffer.alloc(4);
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    length.writeUInt32BE(bytes.length, 0);
    hmac.update(length);
    hmac.update(bytes);
  }
  return hmac.digest();
}

/**
 * Compares two values in time that depends only on their length, never on where they differ.
 * Use it for every comparison that involves a secret, a hash or a signature.
 */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = typeof a === "string" ? Buffer.from(a, "utf8") : a;
  const right = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  if (left.length !== right.length) {
    // Do the same amount of work as a real comparison, then fail.
    nodeTimingSafeEqual(left, left);
    return false;
  }
  return nodeTimingSafeEqual(left, right);
}

/** `bytes` random bytes from the OS CSPRNG, hex-encoded (2 characters per byte). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** `bytes` random bytes from the OS CSPRNG, base64url-encoded without padding. */
export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
