import { type SQL, sql } from "drizzle-orm";
import type { Clock } from "../internal/clock.ts";
import { lazySubkey, randomHex, type SecretSource, timingSafeEqual } from "../internal/crypto.ts";
import { type GroundworkDatabase, rowsOf, toNumber } from "../internal/db.ts";
import { type Duration, parseDuration } from "../internal/duration.ts";
import { errorText, GroundworkError } from "../internal/errors.ts";
import { renewEveryMs } from "../internal/lease.ts";
import { consoleLogger, createOnceLogger, type Logger } from "../internal/logger.ts";
import { assertTableColumns } from "../internal/table.ts";
import { IDEMPOTENCY_KEY_COLUMNS, type IdempotencyKeysTable } from "../schema/idempotency-keys.ts";
import {
  decodeResponse,
  encodeResponse,
  errorResponse,
  isStoredResponse,
  parseIdempotencyKey,
} from "./http.ts";
import { createKeyHasher } from "./keys.ts";
import type { HandleOptions, Idempotency, Jsonify, RunInput, RunResult } from "./types.ts";

export interface IdempotencyOptions {
  /** Your Drizzle Postgres database, from any driver. */
  readonly db: GroundworkDatabase;
  /** `idempotencyKeys` from `groundworkTables()`. */
  readonly table: IdempotencyKeysTable;
  /**
   * The app secret, or a function that returns it on first use. Keys and fingerprints are stored
   * as HMACs with a subkey derived from it. `cleanup()` never needs it.
   */
  readonly secret: SecretSource;
  /** How long a completed result is replayed. Defaults to `"24h"`, as Stripe and VaultDrop do. */
  readonly ttl?: Duration | undefined;
  /**
   * How long a running request holds its key without renewing it. It is renewed every third of
   * this while the request runs, so this is how soon a crashed request frees its key. Defaults to
   * `"30s"`.
   */
  readonly lease?: Duration | undefined;
  /** Defaults to Postgres's `now()`. Inject one in tests. */
  readonly clock?: Clock | undefined;
  /** Defaults to `console` (warnings and errors only). */
  readonly logger?: Logger | undefined;
}

type Claim =
  | { readonly kind: "claimed"; readonly token: string }
  | { readonly kind: "mismatch" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "completed"; readonly response: string };

const MAX_SCOPE_LENGTH = 255;
const MAX_RUN_KEY_LENGTH = 255;
const CLEANUP_BATCH = 5_000;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function checkScope(scope: unknown): string {
  if (typeof scope !== "string" || scope.length === 0 || scope.length > MAX_SCOPE_LENGTH) {
    throw new GroundworkError(
      "invalid_argument",
      `scope must be a string of 1 to ${MAX_SCOPE_LENGTH} characters, such as \`apikey:\${key.id}\`.`,
    );
  }
  return scope;
}

function checkFingerprint(value: unknown): string | Uint8Array | undefined {
  if (value === undefined || typeof value === "string" || value instanceof Uint8Array) return value;
  throw new GroundworkError("invalid_argument", "fingerprint must be a string or a Uint8Array.");
}

/**
 * Creates idempotency keys on your Postgres.
 *
 * ```ts
 * const idempotency = createIdempotency({ db, table: tables.idempotencyKeys, secret });
 * export async function POST(request: Request) {
 *   return idempotency.handle(request, { scope: `user:${user.id}` }, async () => {
 *     const order = await createOrder(await request.json());
 *     return Response.json(order, { status: 201 });
 *   });
 * }
 * ```
 */
export function createIdempotency(options: IdempotencyOptions): Idempotency {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createIdempotency needs an options object.");
  }
  const { db, table, clock } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  assertTableColumns(
    table,
    IDEMPOTENCY_KEY_COLUMNS,
    "idempotency-key table from groundworkTables()",
  );
  const subkey = lazySubkey(options.secret, "idempotency");
  const defaultTtlMs = parseDuration(options.ttl ?? "24h", { label: "ttl", minMs: 1_000 });
  const leaseMs = parseDuration(options.lease ?? "30s", { label: "lease", minMs: 1_000 });
  const logger = options.logger ?? consoleLogger;
  const once = createOnceLogger(logger);

  /** The time a statement works with: the injected clock, else Postgres's `now()`. */
  const now = (): SQL => (clock ? sql`${clock.now().toISOString()}::timestamptz` : sql`now()`);
  const interval = (ms: number): SQL => sql`${ms}::float8 * interval '1 millisecond'`;
  const ttlOf = (ttl: Duration | undefined): number =>
    ttl === undefined ? defaultTtlMs : parseDuration(ttl, { label: "ttl", minMs: 1_000 });

  const hasher = createKeyHasher(subkey);
  const storageKey = hasher.storageKey;
  const fingerprintOf = hasher.fingerprint;

  /**
   * Claims `key` in one statement: inserts it, or takes over a row that has expired or whose
   * request crashed (its lease ran out) with the same fingerprint. Otherwise returns the row as it
   * is. A row inserted by a transaction that committed after this statement's snapshot is
   * invisible to the fallback select, so that case is retried with a fresh snapshot.
   */
  async function begin(
    key: string,
    scope: string,
    fingerprint: string,
    ttlMs: number,
  ): Promise<Claim> {
    const token = randomHex(16);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = rowsOf<{
        state: "claimed" | "existing";
        fingerprint: string | null;
        response: string | null;
        completed: boolean | null;
      }>(
        await db.execute(sql`
          with input as (select ${now()} as now),
          claimed as (
            insert into ${table} as i
              (key, scope, fingerprint, locked_by, locked_until, response, created_at, completed_at, expires_at)
            select ${key}, ${scope}, ${fingerprint}, ${token}, input.now + ${interval(leaseMs)},
              null, input.now, null, input.now + ${interval(ttlMs)}
            from input
            on conflict (key) do update set
              scope = excluded.scope, fingerprint = excluded.fingerprint,
              locked_by = excluded.locked_by, locked_until = excluded.locked_until,
              response = null, created_at = excluded.created_at, completed_at = null,
              expires_at = excluded.expires_at
            where (i.expires_at <= excluded.created_at
                and (i.completed_at is not null or i.locked_until <= excluded.created_at))
              or (i.completed_at is null and i.locked_until <= excluded.created_at
                and i.fingerprint = excluded.fingerprint)
            returning 1
          )
          select 'claimed' as state, null::text as fingerprint, null::text as response,
            null::boolean as completed
          from claimed
          union all
          select 'existing', e.fingerprint, e.response, e.completed_at is not null
          from ${table} as e
          where e.key = ${key} and not exists (select 1 from claimed)`),
      );
      const row = rows[0];
      if (row === undefined) continue;
      if (row.state === "claimed") return { kind: "claimed", token };
      if (!timingSafeEqual(row.fingerprint ?? "", fingerprint)) return { kind: "mismatch" };
      if (row.completed === true && row.response !== null) {
        return { kind: "completed", response: row.response };
      }
      return { kind: "in_progress" };
    }
    // The row keeps changing under us: another request is working on this key right now.
    return { kind: "in_progress" };
  }

  /** Renews the lease every third of its length until the returned function is called. */
  function holdLease(key: string, token: string): () => void {
    const timer = setInterval(() => {
      Promise.resolve(
        db.execute(sql`
            update ${table} set locked_until = ${now()} + ${interval(leaseMs)}
            where key = ${key} and locked_by = ${token} and completed_at is null`),
      ).catch((error: unknown) => {
        once.once("warn", "heartbeat", "Could not renew an idempotency key's lease; retrying.", {
          error: errorText(error),
        });
      });
    }, renewEveryMs(leaseMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Stores the result, unless this request no longer holds the key (its lease ran out). */
  async function complete(
    key: string,
    token: string,
    response: string,
    ttlMs: number,
  ): Promise<void> {
    try {
      const rows = rowsOf(
        await db.execute(sql`
          with input as (select ${now()} as now)
          update ${table} as t set response = ${response}, completed_at = input.now,
            locked_by = null, locked_until = null, expires_at = input.now + ${interval(ttlMs)}
          from input
          where t.key = ${key} and t.locked_by = ${token}
          returning 1`),
      );
      if (rows.length === 0) {
        logger.warn(
          "An idempotent request finished after its key's lease ran out, so its result was not stored. Raise lease if requests run this long.",
        );
      }
    } catch (error) {
      // The work is done; failing the request now would only make the client retry it.
      logger.error("Could not store an idempotent result; a retry may run it again.", {
        error: errorText(error),
      });
    }
  }

  /** Frees the key so the client can retry. If this fails, the lease frees it soon anyway. */
  async function release(key: string, token: string): Promise<void> {
    try {
      await db.execute(sql`delete from ${table} where key = ${key} and locked_by = ${token}`);
    } catch (error) {
      logger.warn("Could not release an idempotency key; it frees itself when its lease ends.", {
        error: errorText(error),
      });
    }
  }

  async function requestFingerprint(
    request: Request,
    custom: string | Uint8Array | undefined,
  ): Promise<string> {
    if (custom !== undefined) return fingerprintOf(["custom", custom]);
    if (request.bodyUsed) {
      throw new GroundworkError(
        "invalid_argument",
        "The request body was already read. Call handle() before reading it, or pass the fingerprint option.",
      );
    }
    const url = new URL(request.url);
    const body =
      request.body === null
        ? new Uint8Array(0)
        : new Uint8Array(await request.clone().arrayBuffer());
    return fingerprintOf([
      "request",
      request.method.toUpperCase(),
      url.pathname + url.search,
      body,
    ]);
  }

  return {
    async handle(request, handleOptions: HandleOptions, handler) {
      if (typeof handleOptions !== "object" || handleOptions === null) {
        throw new GroundworkError("invalid_argument", "handle() needs options with a scope.");
      }
      const scope = checkScope(handleOptions.scope);
      const ttlMs = ttlOf(handleOptions.ttl);
      const custom = checkFingerprint(handleOptions.fingerprint);

      const header = request.headers.get("idempotency-key");
      if (header === null) {
        return handleOptions.required ? errorResponse("idempotency_key_missing") : handler();
      }
      const clientKey = parseIdempotencyKey(header);
      if (clientKey === null) return errorResponse("idempotency_key_invalid");

      const key = storageKey("http", scope, clientKey);
      const claim = await begin(key, scope, await requestFingerprint(request, custom), ttlMs);
      if (claim.kind === "mismatch") return errorResponse("idempotency_key_reused");
      if (claim.kind === "in_progress") return errorResponse("idempotency_key_in_use");
      if (claim.kind === "completed") {
        const stored: unknown = JSON.parse(claim.response);
        if (isStoredResponse(stored)) return decodeResponse(stored);
        // Only a damaged row gets here. Never replay something that can't be rebuilt.
        return errorResponse("idempotency_key_reused");
      }

      const stop = holdLease(key, claim.token);
      let response: Response;
      let body: Uint8Array;
      try {
        response = await handler();
        if (response.status < 200 || response.status >= 400) {
          stop();
          await release(key, claim.token);
          return response;
        }
        body = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        stop();
        await release(key, claim.token);
        throw error;
      }
      stop();
      await complete(key, claim.token, JSON.stringify(encodeResponse(response, body)), ttlMs);
      // The body was read to store it, so send a copy. Every header, cookies included, is kept.
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },

    async run<T>(input: RunInput, fn: () => T | Promise<T>) {
      type Value = Jsonify<Awaited<T>>;
      if (typeof input !== "object" || input === null) {
        throw new GroundworkError("invalid_argument", "run() needs { scope, key }.");
      }
      const scope = checkScope(input.scope);
      if (
        typeof input.key !== "string" ||
        input.key.length === 0 ||
        input.key.length > MAX_RUN_KEY_LENGTH
      ) {
        throw new GroundworkError(
          "invalid_argument",
          `key must be a string of 1 to ${MAX_RUN_KEY_LENGTH} characters.`,
        );
      }
      if (typeof fn !== "function") {
        throw new GroundworkError("invalid_argument", "run() needs a function to run.");
      }
      const custom = checkFingerprint(input.fingerprint);
      const ttlMs = ttlOf(input.ttl);
      const fingerprint = fingerprintOf(custom === undefined ? ["none"] : ["custom", custom]);
      const key = storageKey("run", scope, input.key);

      const claim = await begin(key, scope, fingerprint, ttlMs);
      if (claim.kind === "mismatch" || claim.kind === "in_progress") {
        return { ok: false, reason: claim.kind } satisfies RunResult<Value>;
      }
      if (claim.kind === "completed") {
        const stored = JSON.parse(claim.response) as { value?: Value };
        return {
          ok: true,
          value: stored.value as Value,
          replayed: true,
        } satisfies RunResult<Value>;
      }

      const stop = holdLease(key, claim.token);
      let text: string;
      try {
        const value = await fn();
        try {
          text = JSON.stringify({ value });
        } catch (error) {
          throw new GroundworkError(
            "invalid_argument",
            "run() results are stored as JSON, and this one can't be (a bigint or a cycle?).",
            { cause: error },
          );
        }
      } catch (error) {
        stop();
        await release(key, claim.token);
        throw error;
      }
      stop();
      await complete(key, claim.token, text, ttlMs);
      // Return what a replay will return, so the first call and every retry see the same value.
      const stored = JSON.parse(text) as { value?: Value };
      return { ok: true, value: stored.value as Value, replayed: false } satisfies RunResult<Value>;
    },

    async cleanup() {
      let total = 0;
      for (;;) {
        const [row] = rowsOf<{ deleted: unknown }>(
          await db.execute(sql`
            with input as (select ${now()} as now),
            deleted as (
              delete from ${table} as t
              where t.key in (
                select e.key from ${table} as e, input
                where e.expires_at <= input.now
                  and (e.completed_at is not null or e.locked_until <= input.now)
                limit ${CLEANUP_BATCH}
              )
              returning 1
            )
            select count(*)::int as deleted from deleted`),
        );
        const deleted = row === undefined ? 0 : toNumber(row.deleted);
        total += deleted;
        if (deleted < CLEANUP_BATCH) return total;
      }
    },
  };
}
