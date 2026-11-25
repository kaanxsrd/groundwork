/**
 * groundwork: Postgres-only, Drizzle-native building blocks for rate limiting, audit logs,
 * scoped API keys, background jobs and idempotency keys.
 *
 * ```ts
 * import { createGroundwork } from "@vantedev/groundwork";
 * import * as tables from "./db/schema/groundwork";
 *
 * export const gw = createGroundwork({
 *   db,
 *   tables,
 *   secret: env.GROUNDWORK_SECRET,
 *   audit: { actions: ["post.create", "post.update"] },
 *   apiKeys: { namespace: "vnt", scopes: { "posts:read": "Read posts" } },
 * });
 * const loginLimit = gw.rateLimit.rule({ name: "login:ip", limit: 5, window: "15m" });
 * await gw.audit.record({ actor: { type: "system" }, action: "post.create" });
 * const auth = await gw.apiKeys.verify(request, { scopes: ["posts:read"] });
 * return gw.idempotency.handle(request, { scope: `apikey:${auth.key.id}` }, () => createPost());
 * ```
 *
 * @module @vantedev/groundwork
 */
import { createApiKeys } from "./api-keys/api-keys.ts";
import {
  API_KEY_AUDIT_ACTIONS,
  type ApiKeyAuditAction,
  apiKeyAuditEvent,
} from "./api-keys/audit.ts";
import type { ApiKeyEvent, ApiKeyRateLimit, ApiKeys } from "./api-keys/types.ts";
import { createAuditLog } from "./audit/audit-log.ts";
import type { RedactRule } from "./audit/json.ts";
import type { AuditLog } from "./audit/types.ts";
import { createIdempotency } from "./idempotency/idempotency.ts";
import type { Idempotency } from "./idempotency/types.ts";
import type { Clock } from "./internal/clock.ts";
import {
  checkPreviousSecrets,
  checkSecretSource,
  type PreviousSecretsSource,
  type SecretSource,
} from "./internal/crypto.ts";
import type { GroundworkDatabase } from "./internal/db.ts";
import type { Duration } from "./internal/duration.ts";
import { GroundworkError } from "./internal/errors.ts";
import type { Logger } from "./internal/logger.ts";
import { createJobs } from "./jobs/jobs.ts";
import type { Jobs } from "./jobs/types.ts";
import { createRateLimiter } from "./rate-limit/limiter.ts";
import type { OnError, RateLimiter, RateLimitStore } from "./rate-limit/types.ts";
import type { ApiKeysTable } from "./schema/api-keys.ts";
import type { AuditLogTable } from "./schema/audit-log.ts";
import type { IdempotencyKeysTable } from "./schema/idempotency-keys.ts";
import type { JobSchedulesTable, JobsTable } from "./schema/jobs.ts";
import type { RateLimitsTable } from "./schema/rate-limits.ts";

export type { Clock } from "./internal/clock.ts";
export type { PreviousSecretsSource, Secret, SecretSource } from "./internal/crypto.ts";
export type { GroundworkDatabase } from "./internal/db.ts";
export type { Duration, DurationUnit } from "./internal/duration.ts";
export { GroundworkError, type GroundworkErrorCode, isGroundworkError } from "./internal/errors.ts";
export {
  type ContextFirstLogger,
  type LogContext,
  type Logger,
  pinoLogger,
} from "./internal/logger.ts";

export interface GroundworkOptions<
  TAuditAction extends string = never,
  TAuditEntity extends string = string,
  TScopes extends Record<string, string> = Record<never, string>,
> {
  /**
   * Your Drizzle Postgres database, from any driver. groundwork only calls `execute()`, so a
   * database opened asynchronously works as `{ execute: async (q) => (await getDb()).execute(q) }`.
   */
  readonly db: GroundworkDatabase;
  /**
   * Your groundwork tables, usually `import * as tables from "./db/schema/groundwork"`.
   * Modules whose table is missing throw when you first use them.
   */
  readonly tables: {
    readonly rateLimits?: RateLimitsTable | undefined;
    readonly auditLog?: AuditLogTable | undefined;
    readonly apiKeys?: ApiKeysTable | undefined;
    readonly jobs?: JobsTable | undefined;
    readonly jobSchedules?: JobSchedulesTable | undefined;
    readonly idempotencyKeys?: IdempotencyKeysTable | undefined;
  };
  /**
   * At least 32 bytes. Changing it invalidates every API key and resets every rate limit. Reusing
   * a secret the app already has (such as `BETTER_AUTH_SECRET`) is safe: groundwork only uses keys
   * derived from it with HKDF, never the secret itself.
   *
   * Pass a function to read it on first use instead, for example when the environment isn't set
   * during `next build`, or in a worker that only runs jobs: `secret: () => env.GROUNDWORK_SECRET`.
   */
  readonly secret: SecretSource;
  /**
   * Secrets used before `secret`, newest first, or a function that returns them on first use.
   * API keys stored under one of them still verify, and move to `secret` when they're next used;
   * idempotency keys stored under one are still replayed until they expire. Rate limits start
   * over. See "Rotating the secret" in the core-concepts docs.
   */
  readonly previousSecrets?: PreviousSecretsSource | undefined;
  /** Defaults to `console` (warnings and errors only). */
  readonly logger?: Logger | undefined;
  /** Defaults to each store's own clock. Inject one in tests. */
  readonly clock?: Clock | undefined;
  readonly rateLimit?:
    | {
        /** Defaults to `"memory"`. */
        readonly onError?: OnError | undefined;
        /** Defaults to `"1s"`. */
        readonly timeout?: Duration | false | undefined;
        readonly memory?: { readonly maxKeys?: number | undefined } | undefined;
        /** Another store, such as `redisStore()`, instead of the Postgres table. */
        readonly store?: RateLimitStore | undefined;
      }
    | undefined;
  readonly audit?:
    | {
        /** Every action your app records. `gw.audit` is typed from this list, plus `api_key.*`. */
        readonly actions: readonly TAuditAction[];
        /** Entity types. When given, `entity.type` is typed and checked too (plus `"api_key"`). */
        readonly entityTypes?: readonly TAuditEntity[] | undefined;
        /** Keys to redact in `changes` and `metadata`, on top of `DEFAULT_REDACT`. */
        readonly redact?: readonly RedactRule[] | undefined;
        /** `false` to use only your own `redact` rules. */
        readonly redactDefaults?: boolean | undefined;
      }
    | undefined;
  readonly apiKeys?:
    | {
        /** The start of every key, such as `"vnt"` for `vnt_…`. */
        readonly namespace: string;
        /** Every scope your API knows, with a description. `gw.apiKeys` is typed from it. */
        readonly scopes: TScopes;
        /** Append a CRC32 checksum to new keys. Defaults to `true`. */
        readonly checksum?: boolean | undefined;
        /** The limit new keys get by default: 60 per minute. `null` for none. Uses `gw.rateLimit`. */
        readonly defaultRateLimit?: ApiKeyRateLimit | null | undefined;
        /** The hash an older system stored for a key, so its keys keep working. See the API-key docs. */
        readonly legacyHash?: ((key: string) => string) | undefined;
        /** Called after every change to a key, after the audit entry is written. */
        readonly onEvent?:
          | ((event: ApiKeyEvent<keyof TScopes & string>) => void | Promise<void>)
          | undefined;
        /** Receives background writes, such as Next.js `after` or `ctx.waitUntil`. */
        readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
      }
    | undefined;
  readonly jobs?:
    | {
        /** How long a claimed job is reserved; workers renew it while the job runs. Defaults to `"1m"`. */
        readonly lease?: Duration | undefined;
        /**
         * Identifies this worker in `locked_by`. Defaults to `<hostname>:<pid>:<random>`.
         * Each running process needs its own: two that share one can finish each other's jobs.
         */
        readonly workerId?: string | undefined;
        /**
         * Schedules `gw.rateLimit.cleanup()` every hour when rate limiting is set up. Defaults to
         * `true`.
         */
        readonly rateLimitCleanup?: boolean | undefined;
        /**
         * Schedules `gw.idempotency.cleanup()` every hour when the idempotency table is set up.
         * Defaults to `true`.
         */
        readonly idempotencyCleanup?: boolean | undefined;
      }
    | undefined;
  readonly idempotency?:
    | {
        /** How long a completed response is replayed. Defaults to `"24h"`. */
        readonly ttl?: Duration | undefined;
        /** How soon a crashed request frees its key; renewed while the request runs. Defaults to `"30s"`. */
        readonly lease?: Duration | undefined;
      }
    | undefined;
}

export interface Groundwork<
  TAuditAction extends string = never,
  TAuditEntity extends string = string,
  TScope extends string = never,
> {
  readonly rateLimit: RateLimiter;
  /** Also accepts groundwork's own `api_key.*` actions, which API-key changes record. */
  readonly audit: AuditLog<TAuditAction | ApiKeyAuditAction, TAuditEntity | "api_key">;
  readonly apiKeys: ApiKeys<TScope>;
  readonly jobs: Jobs;
  readonly idempotency: Idempotency;
}

/** Wires every module to one database, one secret, one logger and one clock. */
export function createGroundwork<
  const TAuditAction extends string = never,
  const TAuditEntity extends string = string,
  const TScopes extends Record<string, string> = Record<never, string>,
>(
  options: GroundworkOptions<TAuditAction, TAuditEntity, TScopes>,
): Groundwork<TAuditAction, TAuditEntity, keyof TScopes & string> {
  type TScope = keyof TScopes & string;
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createGroundwork needs an options object.");
  }
  const { db, tables, secret, previousSecrets, logger, clock } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  if (typeof tables !== "object" || tables === null) {
    throw new GroundworkError(
      "invalid_config",
      'tables is required: import * as tables from "./your/groundwork/schema".',
    );
  }
  // A plain secret fails at startup, not on the first request; a function fails on first use.
  checkSecretSource(secret);
  checkPreviousSecrets(previousSecrets);

  const shared = {
    secret,
    ...(logger === undefined ? {} : { logger }),
    ...(clock === undefined ? {} : { clock }),
  };
  // Only the modules whose stored hashes are worth keeping across a change of secret take these.
  const previous = previousSecrets === undefined ? {} : { previousSecrets };
  const missingTable = (module: string, table: string) =>
    new GroundworkError(
      "invalid_config",
      `gw.${module} needs the ${table} table: export it from your groundwork schema file (const { ${table} } = groundworkTables()) and pass it in tables.`,
    );

  let rateLimit: RateLimiter | undefined;
  function getRateLimit(): RateLimiter {
    if (rateLimit) return rateLimit;
    const config = options.rateLimit ?? {};
    const common = {
      ...shared,
      ...(config.onError === undefined ? {} : { onError: config.onError }),
      ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
      ...(config.memory === undefined ? {} : { memory: config.memory }),
    };
    if (config.store !== undefined) {
      rateLimit = createRateLimiter({ ...common, store: config.store });
    } else {
      if (tables.rateLimits === undefined) throw missingTable("rateLimit", "rateLimits");
      rateLimit = createRateLimiter({ ...common, db, table: tables.rateLimits });
    }
    return rateLimit;
  }

  type Audit = AuditLog<TAuditAction | ApiKeyAuditAction, TAuditEntity | "api_key">;
  let audit: Audit | undefined;
  function getAudit(): Audit {
    if (audit) return audit;
    const config = options.audit;
    if (config === undefined) {
      throw new GroundworkError(
        "invalid_config",
        'gw.audit needs its actions: createGroundwork({ audit: { actions: ["post.create", …] } }).',
      );
    }
    if (tables.auditLog === undefined) throw missingTable("audit", "auditLog");
    audit = createAuditLog<TAuditAction | ApiKeyAuditAction, TAuditEntity | "api_key">({
      db,
      table: tables.auditLog,
      actions: [...new Set([...config.actions, ...API_KEY_AUDIT_ACTIONS])],
      entityTypes:
        config.entityTypes === undefined
          ? undefined
          : [...new Set([...config.entityTypes, "api_key" as const])],
      redact: config.redact,
      redactDefaults: config.redactDefaults,
      clock,
    });
    return audit;
  }

  let apiKeys: ApiKeys<TScope> | undefined;
  function getApiKeys(): ApiKeys<TScope> {
    if (apiKeys) return apiKeys;
    const config = options.apiKeys;
    if (config === undefined) {
      throw new GroundworkError(
        "invalid_config",
        'gw.apiKeys needs its namespace and scopes: createGroundwork({ apiKeys: { namespace: "vnt", scopes: { … } } }).',
      );
    }
    if (tables.apiKeys === undefined) throw missingTable("apiKeys", "apiKeys");
    const canRateLimit = options.rateLimit?.store !== undefined || tables.rateLimits !== undefined;
    if (!canRateLimit && config.defaultRateLimit !== null) {
      throw new GroundworkError(
        "invalid_config",
        "API keys get a 60-per-minute limit by default, which needs gw.rateLimit: export the rateLimits table too, or set apiKeys.defaultRateLimit: null.",
      );
    }
    // With the audit log configured, every change to a key is recorded: in the caller's
    // transaction when they pass `tx`, otherwise right after the change (see docs/api-keys.md).
    const auditLog =
      options.audit !== undefined && tables.auditLog !== undefined ? getAudit() : undefined;
    apiKeys = createApiKeys<TScopes>({
      ...shared,
      ...previous,
      db,
      table: tables.apiKeys,
      namespace: config.namespace,
      scopes: config.scopes,
      checksum: config.checksum,
      rateLimiter: canRateLimit ? getRateLimit() : undefined,
      defaultRateLimit: config.defaultRateLimit,
      legacyHash: config.legacyHash,
      waitUntil: config.waitUntil,
      onEvent: async (event) => {
        if (auditLog) await auditLog.record(apiKeyAuditEvent(event), { tx: event.tx });
        if (config.onEvent) await config.onEvent(event);
      },
    });
    return apiKeys;
  }

  let jobs: Jobs | undefined;
  function getJobs(): Jobs {
    if (jobs) return jobs;
    if (tables.jobs === undefined) throw missingTable("jobs", "jobs");
    if (tables.jobSchedules === undefined) throw missingTable("jobs", "jobSchedules");
    const config = options.jobs ?? {};
    // Cached only once the cleanup schedules are on it, so a config error here can't leave a
    // cached instance without them.
    const created = createJobs({
      db,
      table: tables.jobs,
      schedulesTable: tables.jobSchedules,
      lease: config.lease,
      workerId: config.workerId,
      clock,
      logger,
    });
    const canRateLimit = options.rateLimit?.store !== undefined || tables.rateLimits !== undefined;
    if (config.rateLimitCleanup !== false && canRateLimit) {
      const limiter = getRateLimit();
      created.schedule("groundwork.rate-limit-cleanup", { every: "1h" }, async () => ({
        deleted: await limiter.cleanup(),
      }));
    }
    if (config.idempotencyCleanup !== false && tables.idempotencyKeys !== undefined) {
      const keys = getIdempotency();
      created.schedule("groundwork.idempotency-cleanup", { every: "1h" }, async () => ({
        deleted: await keys.cleanup(),
      }));
    }
    jobs = created;
    return created;
  }

  let idempotency: Idempotency | undefined;
  function getIdempotency(): Idempotency {
    if (idempotency) return idempotency;
    if (tables.idempotencyKeys === undefined) throw missingTable("idempotency", "idempotencyKeys");
    const config = options.idempotency ?? {};
    idempotency = createIdempotency({
      ...shared,
      ...previous,
      db,
      table: tables.idempotencyKeys,
      ttl: config.ttl,
      lease: config.lease,
    });
    return idempotency;
  }

  return {
    get rateLimit() {
      return getRateLimit();
    },
    get audit() {
      return getAudit();
    },
    get apiKeys() {
      return getApiKeys();
    },
    get jobs() {
      return getJobs();
    },
    get idempotency() {
      return getIdempotency();
    },
  };
}
