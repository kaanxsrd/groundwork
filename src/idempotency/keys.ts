import { hmacSha256Parts } from "../internal/crypto.ts";

/**
 * How keys and fingerprints are hashed. Both are part of the storage format: changing either
 * makes every stored key unrecognisable, so retries within the TTL would run again.
 */
export interface KeyHasher {
  /** The stored `key`. `http` and `run` keys never collide, even with the same scope and key. */
  storageKey(kind: "http" | "run", scope: string, key: string): string;
  /** The stored `fingerprint` of what a key was used for. */
  fingerprint(parts: readonly (string | Uint8Array)[]): string;
}

export function createKeyHasher(subkey: Uint8Array): KeyHasher {
  return {
    storageKey: (kind, scope, key) =>
      hmacSha256Parts(subkey, [kind, scope, key]).toString("base64url"),
    fingerprint: (parts) =>
      hmacSha256Parts(subkey, ["fingerprint", ...parts]).toString("base64url"),
  };
}
