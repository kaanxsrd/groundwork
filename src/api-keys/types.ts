import type { AuditActor } from "../audit/types.ts";
import type { GroundworkDatabase } from "../internal/db.ts";
import type { Duration } from "../internal/duration.ts";
import type { RateLimitResult } from "../rate-limit/types.ts";
import type { GrantedScope } from "./scopes.ts";

export type ApiKeyStatus = "active" | "suspended" | "expired" | "revoked";

/** At most `limit` requests per `window` for one key. */
export interface ApiKeyRateLimit {
  readonly limit: number;
  readonly window: Duration;
}

/** A key as stored, without its hash. Safe to show in a UI or log. */
export interface ApiKeyRecord<TScope extends string = string> {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** What to show instead of the key: `vnt_3f9ca0c44a15`. */
  readonly prefix: string;
  readonly scopes: readonly GrantedScope<TScope>[];
  readonly ownerId: string | null;
  readonly rateLimit: ApiKeyRateLimit | null;
  readonly dailyQuota: number | null;
  readonly allowedIps: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly metadata: Record<string, unknown> | null;
  /** Worked out from the dates below at the time of the read. */
  readonly status: ApiKeyStatus;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly suspendedUntil: Date | null;
  readonly suspendedReason: string | null;
  readonly rotatedAt: Date | null;
  /** Until when the key from before the last rotation still works. */
  readonly previousKeyExpiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ApiKeyPolicyInput<TScope extends string = string> {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly scopes: readonly GrantedScope<TScope>[];
  readonly ownerId?: string | number | null | undefined;
  /** `null` for no per-key limit. Defaults to the module's `defaultRateLimit`. */
  readonly rateLimit?: ApiKeyRateLimit | null | undefined;
  /** Requests per day, counted from the first request of each day-long window. `null` for none. */
  readonly dailyQuota?: number | null | undefined;
  /** IPv4 and IPv6 addresses or CIDR blocks. Empty allows any address. */
  readonly allowedIps?: readonly string[] | undefined;
  /** Origins such as `https://app.example.com`. Empty allows any origin. */
  readonly allowedOrigins?: readonly string[] | undefined;
  /** Anything else your app keeps with the key. */
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
}

export interface CreateApiKeyInput<TScope extends string = string>
  extends ApiKeyPolicyInput<TScope> {
  /** Expires this long after creation. */
  readonly expiresIn?: Duration | undefined;
  /** Or at this time. Must be in the future. */
  readonly expiresAt?: Date | null | undefined;
}

export type UpdateApiKeyInput<TScope extends string = string> = Partial<
  ApiKeyPolicyInput<TScope>
> & {
  readonly expiresAt?: Date | null | undefined;
};

export interface MutationOptions {
  /** Who is doing this, for the audit log. Defaults to `{ type: "system" }`. */
  readonly actor?: AuditActor | undefined;
  /** Run inside this transaction, together with its audit entry. */
  readonly tx?: GroundworkDatabase | undefined;
}

export type ApiKeyEventType =
  | "create"
  | "update"
  | "rotate"
  | "revoke"
  | "suspend"
  | "reinstate"
  | "delete";

/** Passed to `onEvent` after every change to a key. */
export interface ApiKeyEvent<TScope extends string = string> {
  readonly type: ApiKeyEventType;
  readonly key: ApiKeyRecord<TScope>;
  /** For `update`: the key before the change. */
  readonly before?: ApiKeyRecord<TScope> | undefined;
  readonly actor: AuditActor;
  /** The transaction the change ran in, if any. Record related writes in it. */
  readonly tx?: GroundworkDatabase | undefined;
  readonly reason?: string | null | undefined;
  /** For `rotate`: how long the old key keeps working. */
  readonly grace?: Duration | undefined;
}

export type VerifyFailureReason =
  | "missing"
  | "malformed"
  | "invalid"
  | "revoked"
  | "expired"
  | "suspended"
  | "forbidden_scope"
  | "ip_denied"
  | "origin_denied"
  | "rate_limited"
  | "quota_exceeded";

export interface VerifyOptions<TScope extends string = string> {
  /** Scopes the request needs. All of them must be granted (exactly or by `resource:*`). */
  readonly scopes?: readonly TScope[] | undefined;
  /** The client's IP, for `allowedIps`. Required for keys that have an allowlist. */
  readonly ip?: string | null | undefined;
  /** The request's Origin. Defaults to the `Origin` header of the request passed in. */
  readonly origin?: string | null | undefined;
}

export type VerifyResult<TScope extends string = string> =
  | {
      readonly ok: true;
      readonly key: ApiKeyRecord<TScope>;
      /** Rate-limit headers for the response, when the key has a limit. */
      readonly headers: Readonly<Record<string, string>>;
      /** The per-key limit's check (limit, remaining, reset), or `null` when the key has none. */
      readonly rateLimit: RateLimitResult | null;
      /** The daily quota's check, or `null` when the key has none. */
      readonly quota: RateLimitResult | null;
    }
  | {
      readonly ok: false;
      readonly reason: VerifyFailureReason;
      readonly status: 401 | 403 | 429;
      readonly message: string;
      /** The key, when it was found (revoked, expired, suspended, or denied by its policy). */
      readonly key: ApiKeyRecord<TScope> | null;
      /** The presented key's prefix (`vnt_3f9ca0c44a15`) when it parsed, for logging failed attempts. */
      readonly prefix: string | null;
      /** For `forbidden_scope`: what was missing. */
      readonly missingScopes?: readonly TScope[] | undefined;
      /** For `rate_limited` and `quota_exceeded`: the per-key limit's check. */
      readonly rateLimit?: RateLimitResult | undefined;
      /** For `quota_exceeded`: the daily quota's check. */
      readonly quota?: RateLimitResult | undefined;
      readonly headers: Readonly<Record<string, string>>;
      /** A ready JSON response: `{ "error": { "code", "message" } }` with the right headers. */
      readonly response: Response;
    };

export interface ApiKeyFilter {
  readonly ownerId?: string | number | undefined;
  readonly status?: ApiKeyStatus | readonly ApiKeyStatus[] | undefined;
  /** At most this many keys, newest first. Defaults to 1,000. */
  readonly limit?: number | undefined;
}

export interface ApiKeys<TScope extends string = string> {
  readonly namespace: string;
  /** The declared scopes and their descriptions, for building a UI. */
  readonly scopes: Readonly<Record<TScope, string>>;
  /** Creates a key. `key` is returned once and never stored: show it to the user now. */
  create(
    input: CreateApiKeyInput<TScope>,
    options?: MutationOptions,
  ): Promise<{ readonly key: string; readonly record: ApiKeyRecord<TScope> }>;
  get(id: string): Promise<ApiKeyRecord<TScope> | null>;
  list(filter?: ApiKeyFilter): Promise<ApiKeyRecord<TScope>[]>;
  update(
    id: string,
    patch: UpdateApiKeyInput<TScope>,
    options?: MutationOptions,
  ): Promise<ApiKeyRecord<TScope> | null>;
  /**
   * Issues a new key for the same record. The old key keeps working for `grace` (default
   * `"24h"`; `"0s"` ends it at once). Returns `null` for a revoked or unknown key.
   */
  rotate(
    id: string,
    options?: MutationOptions & { readonly grace?: Duration | undefined },
  ): Promise<{ readonly key: string; readonly record: ApiKeyRecord<TScope> } | null>;
  /** Permanent. The key and any rotated-out key stop working at once. */
  revoke(
    id: string,
    options?: MutationOptions & { readonly reason?: string | undefined },
  ): Promise<ApiKeyRecord<TScope> | null>;
  /** Temporarily blocks the key for `for`, such as `"1h"`. */
  suspend(
    id: string,
    options: MutationOptions & { readonly for: Duration; readonly reason?: string | undefined },
  ): Promise<ApiKeyRecord<TScope> | null>;
  /** Lifts a suspension early. */
  reinstate(id: string, options?: MutationOptions): Promise<ApiKeyRecord<TScope> | null>;
  /** Deletes a revoked key's record. Active keys must be revoked first. */
  delete(id: string, options?: MutationOptions): Promise<boolean>;
  /**
   * Checks a key from a `Request`, `Headers` (`Authorization: Bearer …` or `X-API-Key`) or a raw
   * string. A malformed key is rejected without touching the database.
   */
  verify(
    input: Request | Headers | string | null | undefined,
    options?: VerifyOptions<TScope>,
  ): Promise<VerifyResult<TScope>>;
  /** Replaces any key in `text` with its prefix, for logs and URLs. */
  redactKeys(text: string): string;
}
