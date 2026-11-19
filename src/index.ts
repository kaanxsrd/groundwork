/**
 * groundwork: Postgres-only, Drizzle-native building blocks for rate limiting, audit logs,
 * scoped API keys, background jobs and idempotency keys.
 *
 * ```ts
 * import { createGroundwork } from "groundwork";
 * import * as tables from "./db/schema/groundwork";
 *
 * export const gw = createGroundwork({
 *   db,
 *   tables,
 *   secret: env.GROUNDWORK_SECRET,
 *   audit: { actions: ["post.create", "post.update"] },
 * });
 * const loginLimit = gw.rateLimit.rule({ name: "login:ip", limit: 5, window: "15m" });
 * await gw.audit.record({ actor: { type: "system" }, action: "post.create" });
 * ```
 *
 * @module
 */
import { createAuditLog } from "./audit/audit-log.ts";
import type { RedactRule } from "./audit/json.ts";
import type { AuditLog } from "./audit/types.ts";
import type { Clock } from "./internal/clock.ts";
import { deriveSubkeys, type Secret } from "./internal/crypto.ts";
import type { GroundworkDatabase } from "./internal/db.ts";
import type { Duration } from "./internal/duration.ts";
import { GroundworkError } from "./internal/errors.ts";
import type { Logger } from "./internal/logger.ts";
import { createRateLimiter } from "./rate-limit/limiter.ts";
import type { OnError, RateLimiter, RateLimitStore } from "./rate-limit/types.ts";
import type { AuditLogTable } from "./schema/audit-log.ts";
import type { RateLimitsTable } from "./schema/rate-limits.ts";

export type { Clock } from "./internal/clock.ts";
export type { Secret } from "./internal/crypto.ts";
export type { GroundworkDatabase } from "./internal/db.ts";
export type { Duration, DurationUnit } from "./internal/duration.ts";
export { GroundworkError, type GroundworkErrorCode, isGroundworkError } from "./internal/errors.ts";
export type { LogContext, Logger } from "./internal/logger.ts";

export interface GroundworkOptions<
  TAuditAction extends string = never,
  TAuditEntity extends string = string,
> {
  /** Your Drizzle Postgres database, from any driver. */
  readonly db: GroundworkDatabase;
  /**
   * Your groundwork tables, usually `import * as tables from "./db/schema/groundwork"`.
   * Modules whose table is missing throw when you first use them.
   */
  readonly tables: {
    readonly rateLimits?: RateLimitsTable | undefined;
    readonly auditLog?: AuditLogTable | undefined;
  };
  /** At least 32 bytes. Changing it invalidates every API key and resets every rate limit. */
  readonly secret: Secret;
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
        /** Every action your app records. `gw.audit` is typed from this list. */
        readonly actions: readonly TAuditAction[];
        /** Entity types. When given, `entity.type` is typed and checked too. */
        readonly entityTypes?: readonly TAuditEntity[] | undefined;
        /** Keys to redact in `changes` and `metadata`, on top of `DEFAULT_REDACT`. */
        readonly redact?: readonly RedactRule[] | undefined;
        /** `false` to use only your own `redact` rules. */
        readonly redactDefaults?: boolean | undefined;
      }
    | undefined;
}

export interface Groundwork<
  TAuditAction extends string = never,
  TAuditEntity extends string = string,
> {
  readonly rateLimit: RateLimiter;
  readonly audit: AuditLog<TAuditAction, TAuditEntity>;
}

/** Wires every module to one database, one secret, one logger and one clock. */
export function createGroundwork<
  const TAuditAction extends string = never,
  const TAuditEntity extends string = string,
>(options: GroundworkOptions<TAuditAction, TAuditEntity>): Groundwork<TAuditAction, TAuditEntity> {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createGroundwork needs an options object.");
  }
  const { db, tables, secret, logger, clock } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  if (typeof tables !== "object" || tables === null) {
    throw new GroundworkError(
      "invalid_config",
      'tables is required: import * as tables from "./your/groundwork/schema".',
    );
  }
  // Fail at startup, not on the first request.
  deriveSubkeys(secret);

  const shared = {
    secret,
    ...(logger === undefined ? {} : { logger }),
    ...(clock === undefined ? {} : { clock }),
  };
  const missingTable = (module: string, table: string) =>
    new GroundworkError(
      "invalid_config",
      `gw.${module} needs the ${table} table: export it from your groundwork schema file (const { ${table} } = groundworkTables()) and pass it in tables.`,
    );

  let rateLimit: RateLimiter | undefined;
  let audit: AuditLog<TAuditAction, TAuditEntity> | undefined;
  return {
    get rateLimit(): RateLimiter {
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
    },
    get audit(): AuditLog<TAuditAction, TAuditEntity> {
      if (audit) return audit;
      const config = options.audit;
      if (config === undefined) {
        throw new GroundworkError(
          "invalid_config",
          'gw.audit needs its actions: createGroundwork({ audit: { actions: ["post.create", …] } }).',
        );
      }
      if (tables.auditLog === undefined) throw missingTable("audit", "auditLog");
      audit = createAuditLog<TAuditAction, TAuditEntity>({
        db,
        table: tables.auditLog,
        actions: config.actions,
        entityTypes: config.entityTypes,
        redact: config.redact,
        redactDefaults: config.redactDefaults,
        clock,
      });
      return audit;
    },
  };
}
