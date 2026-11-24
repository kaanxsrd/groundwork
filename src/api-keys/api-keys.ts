import { type SQL, sql } from "drizzle-orm";
import { toJsonObject } from "../audit/json.ts";
import type { AuditActor } from "../audit/types.ts";
import { ipInBlocks } from "../internal/cidr.ts";
import type { Clock } from "../internal/clock.ts";
import { lazySubkey, type SecretSource, timingSafeEqual } from "../internal/crypto.ts";
import { type GroundworkDatabase, jsonbParam, rowsOf, toNumber } from "../internal/db.ts";
import { type Duration, isDuration, parseDuration } from "../internal/duration.ts";
import { GroundworkError } from "../internal/errors.ts";
import { consoleLogger, createOnceLogger, type Logger } from "../internal/logger.ts";
import { assertTableColumns } from "../internal/table.ts";
import type { RateLimiter, RateLimitResult, RateLimitRule } from "../rate-limit/types.ts";
import { API_KEY_COLUMNS, type ApiKeysTable } from "../schema/api-keys.ts";
import {
  displayPrefix,
  generateKey,
  hashKey,
  parseKey,
  redactKeys,
  validateNamespace,
} from "./format.ts";
import {
  createIpCache,
  extractKey,
  normalizeOrigin,
  validateIps,
  validateOrigins,
} from "./policy.ts";
import { failureHeaders, failureResponse, MESSAGES, STATUS } from "./responses.ts";
import { createScopeRules } from "./scopes.ts";
import type {
  ApiKeyEvent,
  ApiKeyFilter,
  ApiKeyRateLimit,
  ApiKeyRecord,
  ApiKeyStatus,
  ApiKeys,
  CreateApiKeyInput,
  MutationOptions,
  UpdateApiKeyInput,
  VerifyFailureReason,
  VerifyOptions,
  VerifyResult,
} from "./types.ts";

export interface ApiKeysOptions<TScopes extends Record<string, string>> {
  readonly db: GroundworkDatabase;
  /** The `apiKeys` table from `groundworkTables()`. */
  readonly table: ApiKeysTable;
  /**
   * The app secret, or a function that returns it on first use. Keys are stored as HMACs under a
   * subkey derived from it.
   */
  readonly secret: SecretSource;
  /** The start of every key, such as `"vnt"` for `vnt_…`. Pick something unique to your app. */
  readonly namespace: string;
  /** Every scope your API knows, with a description: `{ "posts:read": "Read posts" }`. */
  readonly scopes: TScopes;
  /** Append a CRC32 checksum to new keys (`true`, the default). Keys without one still verify. */
  readonly checksum?: boolean | undefined;
  /** Enforces per-key rate limits and daily quotas. Required unless `defaultRateLimit` is `null`. */
  readonly rateLimiter?: RateLimiter | undefined;
  /** The limit new keys get when `create()` doesn't set one. Defaults to 60 per minute. */
  readonly defaultRateLimit?: ApiKeyRateLimit | null | undefined;
  /**
   * For keys created by a previous system: the hash it stored for a key, such as
   * `(key) => createHmac("sha256", oldPepper).update(key).digest("hex")`. Such keys verify, and
   * are moved to groundwork's hash the first time they're used.
   */
  readonly legacyHash?: ((key: string) => string) | undefined;
  /** Called after every change to a key, in its transaction. `createGroundwork` uses it for the audit log. */
  readonly onEvent?:
    | ((event: ApiKeyEvent<keyof TScopes & string>) => void | Promise<void>)
    | undefined;
  /**
   * Receives background writes (`lastUsedAt`) so a serverless platform can wait for them:
   * Next.js `after`, or `ctx.waitUntil`. Defaults to letting them run on their own.
   */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
  /** Defaults to Postgres's time. Inject one in tests. */
  readonly clock?: Clock | undefined;
  /** Defaults to `console` (warnings and errors only). */
  readonly logger?: Logger | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOUCH_EVERY_MS = 60_000;
const MAX_LIST = 1_000;
const SYSTEM: AuditActor = { type: "system" };
const noRedaction = () => false;

const ms = (column: string) => `(extract(epoch from ${column}) * 1000)::float8`;

// The whole record as one JSON object: one parser for every query, the same on every driver.
const RECORD = sql.raw(`jsonb_build_object(
  'id', k.id::text, 'name', k.name, 'description', k.description, 'prefix', k.prefix,
  'scopes', to_jsonb(k.scopes), 'owner_id', k.owner_id,
  'rate_limit', k.rate_limit, 'rate_limit_window', k.rate_limit_window, 'daily_quota', k.daily_quota,
  'allowed_ips', to_jsonb(k.allowed_ips), 'allowed_origins', to_jsonb(k.allowed_origins),
  'metadata', k.metadata,
  'expires_at', ${ms("k.expires_at")}, 'revoked_at', ${ms("k.revoked_at")}, 'revoked_reason', k.revoked_reason,
  'suspended_until', ${ms("k.suspended_until")}, 'suspended_reason', k.suspended_reason,
  'rotated_at', ${ms("k.rotated_at")}, 'previous_key_expires_at', ${ms("k.previous_key_expires_at")},
  'last_used_at', ${ms("k.last_used_at")}, 'last_used_ip', k.last_used_ip, 'created_by', k.created_by,
  'created_at', ${ms("k.created_at")}, 'updated_at', ${ms("k.updated_at")}
)::text`);

interface StoredRecord {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  owner_id: string | null;
  rate_limit: number | null;
  rate_limit_window: string | null;
  daily_quota: number | null;
  allowed_ips: string[];
  allowed_origins: string[];
  metadata: Record<string, unknown> | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  suspended_until: number | null;
  suspended_reason: string | null;
  rotated_at: number | null;
  previous_key_expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const toDate = (value: number | null): Date | null => (value === null ? null : new Date(value));

function statusAt(row: StoredRecord, now: number): ApiKeyStatus {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  if (row.suspended_until !== null && row.suspended_until > now) return "suspended";
  return "active";
}

/** Postgres's error code, whether the driver or Drizzle wrapped it. */
function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown })?.code;
  if (typeof own === "string") return own;
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

/** A text[] parameter. Drizzle expands JS arrays into lists, so they travel as JSON instead. */
const textArray = (values: readonly string[]): SQL =>
  sql`array(select value from jsonb_array_elements_text(${jsonbParam(JSON.stringify(values))}) with ordinality as t(value, position) order by position)::text[]`;

function actorName(actor: AuditActor): string | null {
  if (actor.id !== undefined && actor.id !== null) return String(actor.id);
  return actor.label ?? null;
}

/**
 * Creates scoped API keys stored in your Postgres.
 *
 * ```ts
 * const apiKeys = createApiKeys({ db, table, secret, namespace: "vnt", scopes: { "posts:read": "Read posts" }, rateLimiter });
 * const { key } = await apiKeys.create({ name: "CI", scopes: ["posts:read"] });
 * const auth = await apiKeys.verify(request, { scopes: ["posts:read"] });
 * if (!auth.ok) return auth.response;
 * ```
 */
export function createApiKeys<const TScopes extends Record<string, string>>(
  options: ApiKeysOptions<TScopes>,
): ApiKeys<keyof TScopes & string> {
  type TScope = keyof TScopes & string;
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createApiKeys needs an options object.");
  }
  const { db, table, clock, rateLimiter, legacyHash, onEvent } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  assertTableColumns(table, API_KEY_COLUMNS, "apiKeys table from groundworkTables()");
  const namespace = validateNamespace(options.namespace);
  const scopeRules = createScopeRules(options.scopes);
  const checksum = options.checksum ?? true;
  const subkey = lazySubkey(options.secret, "api-keys");
  const logger = createOnceLogger(options.logger ?? consoleLogger);
  const waitUntil =
    options.waitUntil ??
    ((promise: Promise<unknown>) => {
      void promise;
    });
  if (legacyHash !== undefined && typeof legacyHash !== "function") {
    throw new GroundworkError("invalid_config", "legacyHash must be a function.");
  }

  function validateRateLimit(
    value: unknown,
    label: string,
    code: "invalid_config" | "invalid_argument",
  ): ApiKeyRateLimit | null {
    if (value === null) return null;
    const limit = (value as ApiKeyRateLimit | undefined)?.limit;
    const window = (value as ApiKeyRateLimit | undefined)?.window;
    if (
      typeof value !== "object" ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 2_147_483_647 ||
      !isDuration(window)
    ) {
      throw new GroundworkError(
        code,
        `${label} must be { limit: an integer from 1 to 2,147,483,647, window: a duration such as "1m" }, or null.`,
      );
    }
    parseDuration(window, { label: `${label}.window`, minMs: 1 });
    return { limit: limit as number, window };
  }

  const defaultRateLimit =
    options.defaultRateLimit === undefined
      ? { limit: 60, window: "1m" as const }
      : validateRateLimit(options.defaultRateLimit, "defaultRateLimit", "invalid_config");
  if (defaultRateLimit !== null && rateLimiter === undefined) {
    throw new GroundworkError(
      "invalid_config",
      "API keys get a 60-per-minute limit by default, which needs a rateLimiter. Pass one, or set defaultRateLimit: null.",
    );
  }

  const now = (): SQL => (clock ? sql`${clock.now().toISOString()}::timestamptz` : sql`now()`);
  const ipBlocks = createIpCache();
  const recentTouches = new Map<string, number>();
  const rules = new Map<string, RateLimitRule>();

  function toRecord(row: StoredRecord, at: number): ApiKeyRecord<TScope> {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      prefix: displayPrefix(namespace, row.prefix),
      scopes: row.scopes as ApiKeyRecord<TScope>["scopes"],
      ownerId: row.owner_id,
      rateLimit:
        row.rate_limit === null || row.rate_limit_window === null
          ? null
          : { limit: row.rate_limit, window: row.rate_limit_window as Duration },
      dailyQuota: row.daily_quota,
      allowedIps: row.allowed_ips,
      allowedOrigins: row.allowed_origins,
      metadata: row.metadata,
      status: statusAt(row, at),
      expiresAt: toDate(row.expires_at),
      revokedAt: toDate(row.revoked_at),
      revokedReason: row.revoked_reason,
      suspendedUntil: toDate(row.suspended_until),
      suspendedReason: row.suspended_reason,
      rotatedAt: toDate(row.rotated_at),
      previousKeyExpiresAt: toDate(row.previous_key_expires_at),
      lastUsedAt: toDate(row.last_used_at),
      lastUsedIp: row.last_used_ip,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /** Runs a statement that returns `record` (and optionally `before`) plus `now`. */
  async function run(target: GroundworkDatabase, query: SQL) {
    const rows = rowsOf<{ record: string; before?: string; now: unknown }>(
      await target.execute(query),
    );
    return rows.map((row) => {
      const at = toNumber(row.now);
      return {
        record: toRecord(JSON.parse(row.record) as StoredRecord, at),
        before:
          row.before === undefined
            ? undefined
            : toRecord(JSON.parse(row.before) as StoredRecord, at),
        raw: JSON.parse(row.record) as StoredRecord,
        at,
      };
    });
  }

  /** `with input as (now) <body> select <body result>.record, now`: every mutation's shape. */
  const mutation = (body: SQL, select: SQL = sql`changed.record`) =>
    sql`with input as materialized (select ${now()} as now), ${body} select ${select}, ${sql.raw(ms("input.now"))} as now from changed, input`;

  async function emit(event: ApiKeyEvent<TScope>): Promise<void> {
    if (onEvent) await onEvent(event);
  }

  function policyValues(input: Partial<CreateApiKeyInput<TScope>>, partial: boolean) {
    const out: Record<string, SQL> = {};
    if (!partial || input.name !== undefined) {
      if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 200) {
        throw new GroundworkError(
          "invalid_argument",
          "name must be a non-empty string of at most 200 characters.",
        );
      }
      out.name = sql`${input.name.trim()}::text`;
    }
    if (input.description !== undefined) {
      if (
        input.description !== null &&
        (typeof input.description !== "string" || input.description.length > 2_000)
      ) {
        throw new GroundworkError(
          "invalid_argument",
          "description must be a string of at most 2,000 characters.",
        );
      }
      out.description = sql`${input.description}::text`;
    }
    if (!partial || input.scopes !== undefined) {
      out.scopes = textArray(scopeRules.grantable(input.scopes, "scopes"));
    }
    if (input.ownerId !== undefined) {
      if (
        input.ownerId !== null &&
        typeof input.ownerId !== "string" &&
        typeof input.ownerId !== "number"
      ) {
        throw new GroundworkError("invalid_argument", "ownerId must be a string or a number.");
      }
      out.owner_id = sql`${input.ownerId === null ? null : String(input.ownerId)}::text`;
    }
    if (input.rateLimit !== undefined || !partial) {
      const rateLimit =
        input.rateLimit === undefined
          ? defaultRateLimit
          : validateRateLimit(input.rateLimit, "rateLimit", "invalid_argument");
      if (rateLimit !== null && rateLimiter === undefined) {
        throw new GroundworkError(
          "invalid_argument",
          "A per-key rateLimit needs the module's rateLimiter.",
        );
      }
      out.rate_limit = sql`${rateLimit?.limit ?? null}::int`;
      out.rate_limit_window = sql`${rateLimit?.window ?? null}::text`;
    }
    if (input.dailyQuota !== undefined) {
      if (input.dailyQuota !== null) {
        if (
          !Number.isSafeInteger(input.dailyQuota) ||
          input.dailyQuota < 1 ||
          input.dailyQuota > 2_147_483_647
        ) {
          throw new GroundworkError(
            "invalid_argument",
            "dailyQuota must be a positive integer, or null.",
          );
        }
        if (rateLimiter === undefined) {
          throw new GroundworkError(
            "invalid_argument",
            "A dailyQuota needs the module's rateLimiter.",
          );
        }
      }
      out.daily_quota = sql`${input.dailyQuota}::int`;
    }
    if (input.allowedIps !== undefined)
      out.allowed_ips = textArray(validateIps(input.allowedIps, "allowedIps"));
    if (input.allowedOrigins !== undefined) {
      out.allowed_origins = textArray(validateOrigins(input.allowedOrigins, "allowedOrigins"));
    }
    if (input.metadata !== undefined) {
      const metadata = toJsonObject(input.metadata, noRedaction, "metadata");
      out.metadata = jsonbParam(metadata === null ? null : JSON.stringify(metadata));
    }
    if (input.expiresAt !== undefined) {
      if (input.expiresAt !== null) {
        if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
          throw new GroundworkError("invalid_argument", "expiresAt must be a valid Date, or null.");
        }
        if (input.expiresAt.getTime() <= (clock?.now() ?? new Date()).getTime()) {
          throw new GroundworkError("invalid_argument", "expiresAt must be in the future.");
        }
      }
      out.expires_at = sql`${input.expiresAt === null ? null : input.expiresAt.toISOString()}::timestamptz`;
    }
    return out;
  }

  const validId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

  function ruleFor(kind: "rate" | "quota", limit: number, window: Duration): RateLimitRule {
    const id = `${kind}/${limit}/${window}`;
    let rule = rules.get(id);
    if (!rule) {
      if (!rateLimiter) {
        throw new GroundworkError(
          "invalid_config",
          "This key has a rate limit or quota, but the API-key module has no rateLimiter.",
        );
      }
      // One name per kind: changing a key's limit keeps its counter.
      rule = rateLimiter.rule({
        name: kind === "rate" ? `${namespace}:key` : `${namespace}:key.daily`,
        limit,
        window,
      });
      if (rules.size >= 1_000) rules.clear();
      rules.set(id, rule);
    }
    return rule;
  }

  function fail(
    reason: VerifyFailureReason,
    key: ApiKeyRecord<TScope> | null = null,
    extra: {
      missingScopes?: TScope[];
      rateLimit?: RateLimitResult;
      quota?: RateLimitResult;
      prefix?: string;
    } = {},
  ): VerifyResult<TScope> {
    const missingScopes = extra.missingScopes ?? [];
    const denying = extra.quota ?? extra.rateLimit;
    const headers = failureHeaders(reason, missingScopes, denying?.headers ?? {});
    return {
      ok: false,
      reason,
      status: STATUS[reason],
      message: MESSAGES[reason],
      key,
      prefix: extra.prefix ?? null,
      ...(missingScopes.length > 0 ? { missingScopes } : {}),
      ...(extra.rateLimit ? { rateLimit: extra.rateLimit } : {}),
      ...(extra.quota ? { quota: extra.quota } : {}),
      headers,
      response: failureResponse(reason, headers, missingScopes),
    };
  }

  /** Records lastUsedAt / lastUsedIp at most once a minute per key, off the request's path. */
  function touch(
    row: StoredRecord,
    at: number,
    ip: string | null,
    legacy: { from: string; to: string } | null,
  ) {
    const recent = recentTouches.get(row.id);
    const stale =
      (row.last_used_at === null || at - row.last_used_at >= TOUCH_EVERY_MS) &&
      (recent === undefined || at - recent >= TOUCH_EVERY_MS);
    if (!stale && !legacy) return;
    if (stale) {
      if (recentTouches.size >= 10_000) recentTouches.clear();
      recentTouches.set(row.id, at);
    }
    const work = (async () => {
      if (legacy) {
        // Move a legacy key to groundwork's hash, once.
        await db.execute(
          sql`update ${table} as k set key_hash = ${legacy.to}::text where k.id = ${row.id}::uuid and k.key_hash = ${legacy.from}::text`,
        );
      }
      if (stale) {
        await db.execute(sql`
          update ${table} as k set last_used_at = ${now()}, last_used_ip = ${ip}::text
          where k.id = ${row.id}::uuid
            and (k.last_used_at is null or k.last_used_at <= ${now()} - interval '1 minute')`);
      }
    })().catch((error: unknown) => {
      logger.once(
        "warn",
        "touch",
        "Could not record an API key's last use; it will be retried on later requests.",
        {
          error:
            error instanceof Error ? { name: error.name, message: error.message } : String(error),
        },
      );
    });
    waitUntil(work);
  }

  const apiKeys: ApiKeys<TScope> = {
    namespace,
    scopes: Object.freeze({ ...options.scopes }) as Readonly<Record<TScope, string>>,

    async create(input, mutationOptions?: MutationOptions) {
      if (typeof input !== "object" || input === null) {
        throw new GroundworkError("invalid_argument", "create needs { name, scopes }.");
      }
      const actor = mutationOptions?.actor ?? SYSTEM;
      const values = policyValues(input, false);
      let expires: SQL = sql`null::timestamptz`;
      if (
        input.expiresIn !== undefined &&
        input.expiresAt !== undefined &&
        input.expiresAt !== null
      ) {
        throw new GroundworkError("invalid_argument", "Pass expiresIn or expiresAt, not both.");
      }
      if (input.expiresIn !== undefined) {
        const inMs = parseDuration(input.expiresIn, { label: "expiresIn", minMs: 1 });
        expires = sql`input.now + ${inMs}::float8 * interval '1 millisecond'`;
      } else if (values.expires_at) {
        expires = values.expires_at;
      }
      const target = mutationOptions?.tx ?? db;

      // A 48-bit prefix can collide; the unique index catches it, and we draw a new key. Only the
      // insert is retried: a unique violation from onEvent must not create another key.
      let created: { key: string; record: ApiKeyRecord<TScope> } | undefined;
      for (let attempt = 0; created === undefined; attempt++) {
        const generated = generateKey(namespace, checksum);
        try {
          const [result] = await run(
            target,
            mutation(sql`changed as (
              insert into ${table} as k (name, description, prefix, key_hash, scopes, owner_id, rate_limit, rate_limit_window, daily_quota, allowed_ips, allowed_origins, metadata, expires_at, created_by, created_at, updated_at)
              select ${values.name}, ${values.description ?? sql`null::text`}, ${generated.prefix}::text, ${hashKey(subkey(), generated.body)}::text,
                ${values.scopes}, ${values.owner_id ?? sql`null::text`}, ${values.rate_limit}, ${values.rate_limit_window},
                ${values.daily_quota ?? sql`null::int`}, ${values.allowed_ips ?? sql`'{}'::text[]`}, ${values.allowed_origins ?? sql`'{}'::text[]`},
                ${values.metadata ?? sql`null::jsonb`}, ${expires}, ${actorName(actor)}::text, input.now, input.now
              from input
              returning ${RECORD} as record
            )`),
          );
          if (!result) throw new Error("API key insert returned no row");
          created = { key: generated.key, record: result.record };
        } catch (error) {
          if (pgCode(error) === "23505" && attempt < 3) continue;
          throw error;
        }
      }
      try {
        await emit({ type: "create", key: created.record, actor, tx: mutationOptions?.tx });
      } catch (error) {
        // Without a tx the key is already committed, but the caller never sees its plaintext:
        // delete it, so a failed audit write leaves no active key that nobody holds. With a tx,
        // the caller's rollback undoes the insert.
        if (mutationOptions?.tx === undefined) {
          await db.execute(sql`delete from ${table} as k where k.id = ${created.record.id}::uuid`);
        }
        throw error;
      }
      return created;
    },

    async get(id) {
      if (!validId(id)) return null;
      const [result] = await run(
        db,
        sql`with input as materialized (select ${now()} as now)
            select ${RECORD} as record, ${sql.raw(ms("input.now"))} as now from ${table} as k, input where k.id = ${id}::uuid`,
      );
      return result?.record ?? null;
    },

    async list(filter: ApiKeyFilter = {}) {
      const limit = filter.limit ?? MAX_LIST;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) {
        throw new GroundworkError(
          "invalid_argument",
          `limit must be an integer from 1 to ${MAX_LIST}.`,
        );
      }
      const conditions: SQL[] = [];
      if (filter.ownerId !== undefined)
        conditions.push(sql`k.owner_id = ${String(filter.ownerId)}::text`);
      if (filter.status !== undefined) {
        const statuses = (
          Array.isArray(filter.status) ? filter.status : [filter.status]
        ) as ApiKeyStatus[];
        const byStatus: Record<ApiKeyStatus, SQL> = {
          revoked: sql`k.revoked_at is not null`,
          expired: sql`(k.revoked_at is null and k.expires_at <= input.now)`,
          suspended: sql`(k.revoked_at is null and (k.expires_at is null or k.expires_at > input.now) and k.suspended_until > input.now)`,
          active: sql`(k.revoked_at is null and (k.expires_at is null or k.expires_at > input.now) and (k.suspended_until is null or k.suspended_until <= input.now))`,
        };
        for (const status of statuses) {
          if (!(status in byStatus)) {
            throw new GroundworkError(
              "invalid_argument",
              `Unknown status ${JSON.stringify(status)}.`,
            );
          }
        }
        conditions.push(
          statuses.length === 0
            ? sql`false`
            : sql`(${sql.join(
                statuses.map((s) => byStatus[s]),
                sql` or `,
              )})`,
        );
      }
      const where =
        conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`;
      const results = await run(
        db,
        sql`with input as materialized (select ${now()} as now)
            select ${RECORD} as record, ${sql.raw(ms("input.now"))} as now from ${table} as k, input ${where}
            order by k.created_at desc, k.id desc limit ${limit}`,
      );
      return results.map((result) => result.record);
    },

    async update(id, patch: UpdateApiKeyInput<TScope>, mutationOptions?: MutationOptions) {
      if (typeof patch !== "object" || patch === null) {
        throw new GroundworkError(
          "invalid_argument",
          "update needs an object of fields to change.",
        );
      }
      const values = policyValues(patch, true);
      if (!validId(id)) return null;
      const assignments = Object.entries(values).map(
        ([column, value]) => sql`${sql.raw(column)} = ${value}`,
      );
      const [result] = await run(
        mutationOptions?.tx ?? db,
        mutation(
          sql`before as (select ${RECORD} as record, k.id from ${table} as k where k.id = ${id}::uuid for update),
              changed as (
                update ${table} as k set ${sql.join([...assignments, sql`updated_at = input.now`], sql`, `)}
                from input, before where k.id = before.id
                returning ${RECORD} as record
              )`,
          sql`changed.record, (select record from before) as before`,
        ),
      );
      if (!result) return null;
      await emit({
        type: "update",
        key: result.record,
        before: result.before,
        actor: mutationOptions?.actor ?? SYSTEM,
        tx: mutationOptions?.tx,
      });
      return result.record;
    },

    async rotate(id, rotateOptions = {}) {
      const grace = rotateOptions.grace ?? "24h";
      const graceMs = parseDuration(grace, { label: "grace" });
      if (!validId(id)) return null;
      // The new prefix can collide like create()'s does; draw another key, as create() does.
      let generated = generateKey(namespace, checksum);
      let result: { record: ApiKeyRecord<TScope> } | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          [result] = await run(
            rotateOptions.tx ?? db,
            mutation(sql`changed as (
              update ${table} as k set
                key_hash = ${hashKey(subkey(), generated.body)}::text,
                prefix = ${generated.prefix}::text,
                previous_key_hash = case when ${graceMs}::float8 > 0 then k.key_hash else null end,
                previous_key_expires_at = case when ${graceMs}::float8 > 0 then input.now + ${graceMs}::float8 * interval '1 millisecond' else null end,
                rotated_at = input.now,
                updated_at = input.now
              from input where k.id = ${id}::uuid and k.revoked_at is null
              returning ${RECORD} as record
            )`),
          );
          break;
        } catch (error) {
          if (pgCode(error) === "23505" && attempt < 3) {
            generated = generateKey(namespace, checksum);
            continue;
          }
          throw error;
        }
      }
      if (!result) return null;
      await emit({
        type: "rotate",
        key: result.record,
        actor: rotateOptions.actor ?? SYSTEM,
        tx: rotateOptions.tx,
        grace,
      });
      return { key: generated.key, record: result.record };
    },

    async revoke(id, revokeOptions = {}) {
      const reason = revokeOptions.reason ?? null;
      if (reason !== null && typeof reason !== "string") {
        throw new GroundworkError("invalid_argument", "reason must be a string.");
      }
      if (!validId(id)) return null;
      const [result] = await run(
        revokeOptions.tx ?? db,
        mutation(sql`changed as (
          update ${table} as k set revoked_at = input.now, revoked_reason = ${reason}::text,
            previous_key_hash = null, previous_key_expires_at = null, updated_at = input.now
          from input where k.id = ${id}::uuid and k.revoked_at is null
          returning ${RECORD} as record
        )`),
      );
      if (!result) return null;
      await emit({
        type: "revoke",
        key: result.record,
        actor: revokeOptions.actor ?? SYSTEM,
        tx: revokeOptions.tx,
        reason,
      });
      return result.record;
    },

    async suspend(id, suspendOptions) {
      if (typeof suspendOptions !== "object" || suspendOptions === null) {
        throw new GroundworkError("invalid_argument", 'suspend needs { for: "1h" }.');
      }
      const forMs = parseDuration(suspendOptions.for, { label: "for", minMs: 1 });
      const reason = suspendOptions.reason ?? null;
      if (reason !== null && typeof reason !== "string") {
        throw new GroundworkError("invalid_argument", "reason must be a string.");
      }
      if (!validId(id)) return null;
      const [result] = await run(
        suspendOptions.tx ?? db,
        mutation(sql`changed as (
          update ${table} as k set suspended_until = input.now + ${forMs}::float8 * interval '1 millisecond',
            suspended_reason = ${reason}::text, updated_at = input.now
          from input where k.id = ${id}::uuid and k.revoked_at is null
          returning ${RECORD} as record
        )`),
      );
      if (!result) return null;
      await emit({
        type: "suspend",
        key: result.record,
        actor: suspendOptions.actor ?? SYSTEM,
        tx: suspendOptions.tx,
        reason,
      });
      return result.record;
    },

    async reinstate(id, mutationOptions: MutationOptions = {}) {
      if (!validId(id)) return null;
      const [result] = await run(
        mutationOptions.tx ?? db,
        mutation(sql`changed as (
          update ${table} as k set suspended_until = null, suspended_reason = null, updated_at = input.now
          from input where k.id = ${id}::uuid and k.revoked_at is null
          returning ${RECORD} as record
        )`),
      );
      if (!result) return null;
      await emit({
        type: "reinstate",
        key: result.record,
        actor: mutationOptions.actor ?? SYSTEM,
        tx: mutationOptions.tx,
      });
      return result.record;
    },

    async delete(id, mutationOptions: MutationOptions = {}) {
      if (!validId(id)) return false;
      const [result] = await run(
        mutationOptions.tx ?? db,
        mutation(sql`changed as (
          delete from ${table} as k where k.id = ${id}::uuid and k.revoked_at is not null
          returning ${RECORD} as record
        )`),
      );
      if (!result) return false;
      await emit({
        type: "delete",
        key: result.record,
        actor: mutationOptions.actor ?? SYSTEM,
        tx: mutationOptions.tx,
      });
      return true;
    },

    async verify(input, verifyOptions: VerifyOptions<TScope> = {}) {
      const raw = extractKey(input);
      if (raw === null) return fail("missing");
      // Malformed keys, including typos caught by the checksum, never reach the database.
      const parsed = parseKey(raw, namespace);
      if (parsed === null) return fail("malformed");
      // From here on, failures carry the presented key's prefix (never the key) for logging.
      const presented = displayPrefix(namespace, parsed.prefix);
      const denied = (
        reason: VerifyFailureReason,
        key: ApiKeyRecord<TScope> | null = null,
        extra: {
          missingScopes?: TScope[];
          rateLimit?: RateLimitResult;
          quota?: RateLimitResult;
        } = {},
      ) => fail(reason, key, { ...extra, prefix: presented });

      const hash = hashKey(subkey(), parsed.body);
      const legacy = legacyHash ? legacyHash(parsed.body) : null;
      if (legacy !== null && typeof legacy !== "string") {
        throw new GroundworkError("invalid_config", "legacyHash must return a string.");
      }
      // One round trip: the current key, or the previous one within its grace period.
      const rows = rowsOf<{
        record: string;
        key_hash: string;
        previous_key_hash: string | null;
        now: unknown;
      }>(
        await db.execute(sql`
          with input as materialized (select ${now()} as now)
          select ${RECORD} as record, k.key_hash, k.previous_key_hash, ${sql.raw(ms("input.now"))} as now
          from ${table} as k, input
          where k.key_hash in (${hash}::text, ${legacy}::text)
             or (k.previous_key_hash in (${hash}::text, ${legacy}::text) and k.previous_key_expires_at > input.now)
          limit 1`),
      );
      const row = rows[0];
      if (!row) return denied("invalid");
      const at = toNumber(row.now);
      const stored = JSON.parse(row.record) as StoredRecord;
      const matches = (candidate: string | null) =>
        candidate !== null &&
        (timingSafeEqual(candidate, hash) ||
          (legacy !== null && timingSafeEqual(candidate, legacy)));
      const current = matches(row.key_hash);
      const previous =
        !current &&
        matches(row.previous_key_hash) &&
        stored.previous_key_expires_at !== null &&
        stored.previous_key_expires_at > at;
      if (!current && !previous) return denied("invalid");

      const key = toRecord(stored, at);
      if (key.status === "revoked") return denied("revoked", key);
      if (key.status === "expired") return denied("expired", key);
      if (key.status === "suspended") return denied("suspended", key);

      const request =
        input === null || input === undefined || typeof input === "string"
          ? null
          : input instanceof Headers
            ? input
            : input.headers;
      const ip = verifyOptions.ip ?? null;
      if (key.allowedIps.length > 0 && (ip === null || !ipInBlocks(ip, ipBlocks(key.allowedIps)))) {
        return denied("ip_denied", key);
      }
      const origin =
        verifyOptions.origin !== undefined
          ? verifyOptions.origin
          : (request?.get("origin") ?? null);
      // Only browsers send Origin; a request without one isn't held to the list.
      if (key.allowedOrigins.length > 0 && origin !== null) {
        const normalized = normalizeOrigin(origin);
        if (normalized === null || !key.allowedOrigins.includes(normalized))
          return denied("origin_denied", key);
      }
      const required = verifyOptions.scopes ?? [];
      const missingScopes = scopeRules.missing(key.scopes, required) as TScope[];
      if (missingScopes.length > 0) return denied("forbidden_scope", key, { missingScopes });

      let rateLimit: RateLimitResult | null = null;
      if (key.rateLimit) {
        rateLimit = await ruleFor("rate", key.rateLimit.limit, key.rateLimit.window).check(key.id);
        if (!rateLimit.allowed) return denied("rate_limited", key, { rateLimit });
      }
      let quota: RateLimitResult | null = null;
      if (key.dailyQuota !== null) {
        quota = await ruleFor("quota", key.dailyQuota, "1d").check(key.id);
        if (!quota.allowed) {
          return denied("quota_exceeded", key, rateLimit ? { rateLimit, quota } : { quota });
        }
      }

      const legacyMatch = current && legacy !== null && timingSafeEqual(row.key_hash, legacy);
      touch(stored, at, ip, legacyMatch ? { from: legacy, to: hash } : null);
      return { ok: true, key, headers: rateLimit?.headers ?? {}, rateLimit, quota };
    },

    redactKeys: (text) => redactKeys(text, namespace),
  };
  return apiKeys;
}
