import { type SQL, sql } from "drizzle-orm";
import type { Clock } from "../internal/clock.ts";
import {
  lazyPreviousSubkeys,
  lazySubkey,
  type PreviousSecretsSource,
  randomHex,
  type SecretSource,
  timingSafeEqual,
} from "../internal/crypto.ts";
import { type GroundworkDatabase, rowsOf, toNumber } from "../internal/db.ts";
import { type Duration, MAX_TIMER_MS, parseDuration } from "../internal/duration.ts";
import { errorText, GroundworkError } from "../internal/errors.ts";
import { renewEveryMs } from "../internal/lease.ts";
import { consoleLogger, createOnceLogger, type Logger } from "../internal/logger.ts";
import { assertTableColumns } from "../internal/table.ts";
import { storableId } from "../internal/text.ts";
import { IDEMPOTENCY_KEY_COLUMNS, type IdempotencyKeysTable } from "../schema/idempotency-keys.ts";
import {
  decodeResponse,
  encodeResponse,
  errorResponse,
  isStoredResponse,
  parseIdempotencyKey,
} from "./http.ts";
import { createKeyHasher, type KeyHasher } from "./keys.ts";
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
  /**
   * Secrets used before `secret`. A key stored under one of them is still recognised until it
   * expires, so a retry that straddles a change of secret is replayed, not run again. See
   * "Rotating the secret" in the core-concepts docs.
   */
  readonly previousSecrets?: PreviousSecretsSource | undefined;
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

/** How one key, and what it's used for, is stored under one secret. */
interface Stored {
  readonly key: string;
  readonly fingerprint: string;
}

/** The key under the current secret, and under each previous one. */
interface Identity {
  readonly current: Stored;
  readonly previous: readonly Stored[];
}

type FingerprintParts = readonly (string | Uint8Array)[];

type Claim =
  | { readonly kind: "claimed"; readonly token: string; readonly keys: readonly string[] }
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
  return storableId(scope, "scope");
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
  const leaseMs = parseDuration(options.lease ?? "30s", {
    label: "lease",
    minMs: 1_000,
    maxMs: MAX_TIMER_MS,
  });
  const logger = options.logger ?? consoleLogger;
  const once = createOnceLogger(logger);

  /** The time a statement works with: the injected clock, else Postgres's `now()`. */
  const now = (): SQL => (clock ? sql`${clock.now().toISOString()}::timestamptz` : sql`now()`);
  const interval = (ms: number): SQL => sql`${ms}::float8 * interval '1 millisecond'`;
  const ttlOf = (ttl: Duration | undefined): number =>
    ttl === undefined ? defaultTtlMs : parseDuration(ttl, { label: "ttl", minMs: 1_000 });

  const hasher = createKeyHasher(subkey);
  const previousSubkeys = lazyPreviousSubkeys(options.previousSecrets, "idempotency");
  let previousHashers: readonly KeyHasher[] | undefined;

  /** How `key` and its fingerprint are stored under the current secret and the previous ones. */
  function identify(
    kind: "http" | "run",
    scope: string,
    key: string,
    parts: FingerprintParts,
  ): Identity {
    previousHashers ??= previousSubkeys().map((previousKey) => createKeyHasher(() => previousKey));
    const under = (keys: KeyHasher): Stored => ({
      key: keys.storageKey(kind, scope, key),
      fingerprint: keys.fingerprint(parts),
    });
    return { current: under(hasher), previous: previousHashers.map(under) };
  }

  /**
   * The rows a claim holds. Without previous secrets, one: the key under the secret. With them,
   * one under every secret, so a claim made under any of them conflicts with this one in the
   * unique index. That's what keeps the two-deploy rollout safe, where some instances still store
   * the old secret's key while others already store the new one's: each pair that can run at the
   * same time shares a secret. Sorted by key in byte order, the order `collate "C"` uses, so
   * claims and completions that share keys lock them in the same order and can't deadlock.
   */
  function rowsOfClaim(identity: Identity): readonly Stored[] {
    const unique = new Map<string, Stored>();
    for (const stored of [identity.current, ...identity.previous]) unique.set(stored.key, stored);
    return [...unique.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** The conflict rule for one row: take over a row that has expired or whose request crashed. */
  const takeover = sql`
    on conflict (key) do update set
      scope = excluded.scope, fingerprint = excluded.fingerprint,
      locked_by = excluded.locked_by, locked_until = excluded.locked_until,
      response = null, created_at = excluded.created_at, completed_at = null,
      expires_at = excluded.expires_at
    where (i.expires_at <= excluded.created_at
        and (i.completed_at is not null or i.locked_until <= excluded.created_at))
      or (i.completed_at is null and i.locked_until <= excluded.created_at
        and i.fingerprint = excluded.fingerprint)`;

  async function begin(identity: Identity, scope: string, ttlMs: number): Promise<Claim> {
    const stored = rowsOfClaim(identity);
    const token = randomHex(16);
    const only = stored.length === 1 ? stored[0] : undefined;
    return only
      ? beginOne(only, scope, ttlMs, token)
      : beginEverywhere(stored, scope, ttlMs, token);
  }

  /**
   * Claims a key in one statement: inserts it, or takes over a row that has expired or whose
   * request crashed (its lease ran out) with the same fingerprint. Otherwise returns the row as it
   * is. A row inserted by a transaction that committed after this statement's snapshot is
   * invisible to the fallback select, so that case is retried with a fresh snapshot.
   */
  async function beginOne(
    { key, fingerprint }: Stored,
    scope: string,
    ttlMs: number,
    token: string,
  ): Promise<Claim> {
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
            ${takeover}
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
      if (row.state === "claimed") return { kind: "claimed", token, keys: [key] };
      if (!timingSafeEqual(row.fingerprint ?? "", fingerprint)) return { kind: "mismatch" };
      if (row.completed === true && row.response !== null) {
        return { kind: "completed", response: row.response };
      }
      return { kind: "in_progress" };
    }
    // The row keeps changing under us: another request is working on this key right now.
    return { kind: "in_progress" };
  }

  /**
   * Claims a key under every secret at once, each row by the same rule as `beginOne`. The claim
   * only counts if it got every row. Otherwise the rows it didn't get answer, as `beginOne`'s
   * single row would (a mismatch, a stored result, or "in progress"), and the rows it did get
   * are given back.
   */
  async function beginEverywhere(
    stored: readonly Stored[],
    scope: string,
    ttlMs: number,
    token: string,
  ): Promise<Claim> {
    const keys = stored.map((row) => row.key);
    const expected = new Map(stored.map((row) => [row.key, row.fingerprint]));
    const wanted = sql.join(
      stored.map((row, ord) => sql`(${ord}::int, ${row.key}::text, ${row.fingerprint}::text)`),
      sql`, `,
    );
    const keyList = sql.join(
      keys.map((key) => sql`${key}::text`),
      sql`, `,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = rowsOf<{
        state: "claimed" | "existing";
        key: string;
        fingerprint: string | null;
        response: string | null;
        completed: boolean | null;
      }>(
        await db.execute(sql`
          with input as (select ${now()} as now),
          wanted (ord, key, fingerprint) as (values ${wanted}),
          claimed as (
            insert into ${table} as i
              (key, scope, fingerprint, locked_by, locked_until, response, created_at, completed_at, expires_at)
            select w.key, ${scope}, w.fingerprint, ${token}, input.now + ${interval(leaseMs)},
              null, input.now, null, input.now + ${interval(ttlMs)}
            from wanted as w, input
            order by w.ord
            ${takeover}
            returning i.key
          )
          select 'claimed' as state, c.key, null::text as fingerprint, null::text as response,
            null::boolean as completed
          from claimed as c
          union all
          select 'existing', e.key, e.fingerprint, e.response, e.completed_at is not null
          from ${table} as e
          where e.key in (${keyList}) and e.key not in (select key from claimed)`),
      );
      const got = rows.filter((row) => row.state === "claimed").map((row) => row.key);
      if (got.length === keys.length) return { kind: "claimed", token, keys };
      if (got.length > 0) await release(got, token);
      const others = rows.filter((row) => row.state === "existing");
      // Every row it didn't get committed after this statement's snapshot: look again.
      if (others.length === 0) continue;
      // Each row carries its own secret's fingerprint. All are compared, so the time taken
      // doesn't depend on which one differs.
      const mismatched = others
        .map((row) => !timingSafeEqual(row.fingerprint ?? "", expected.get(row.key) ?? ""))
        .reduce((any, differs) => any || differs, false);
      if (mismatched) return { kind: "mismatch" };
      const done = others.find((row) => row.completed === true && row.response !== null);
      if (done?.response) return { kind: "completed", response: done.response };
      return { kind: "in_progress" };
    }
    return { kind: "in_progress" };
  }

  const keyIn = (keys: readonly string[]) =>
    sql.join(
      keys.map((key) => sql`${key}::text`),
      sql`, `,
    );

  /**
   * This claim's rows, locked in byte order. Every statement that changes several rows of one
   * claim locks them first, so they're always taken in the order claims take them. Postgres's own
   * order (an index's collation, or where rows sit on disk) can differ, and two statements that
   * take shared rows in different orders can deadlock.
   */
  const lockMine = (keys: readonly string[], token: string, extra: SQL = sql``) => sql`
    mine as (
      select m.key from ${table} as m
      where m.key in (${keyIn(keys)}) and m.locked_by = ${token} ${extra}
      order by m.key collate "C"
      for update
    )`;

  /** Renews the lease every third of its length until the returned function is called. */
  function holdLease(keys: readonly string[], token: string): () => void {
    const renew = sql`locked_until = ${now()} + ${interval(leaseMs)}`;
    const timer = setInterval(() => {
      Promise.resolve(
        db.execute(
          keys.length === 1
            ? sql`
            update ${table} set ${renew}
            where key = ${keys[0]} and locked_by = ${token} and completed_at is null`
            : sql`
            with ${lockMine(keys, token, sql`and m.completed_at is null`)}
            update ${table} set ${renew} where key in (select key from mine)`,
        ),
      ).catch((error: unknown) => {
        once.once("warn", "heartbeat", "Could not renew an idempotency key's lease; retrying.", {
          error: errorText(error),
        });
      });
    }, renewEveryMs(leaseMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Stores the result, unless this request no longer holds the key (its lease ran out). A claim
   * under several secrets locks all its rows first, in key order, and stores the result only if
   * it still holds every one: a request that another took over part of mustn't half-complete.
   */
  async function complete(
    keys: readonly string[],
    token: string,
    response: string,
    ttlMs: number,
  ): Promise<void> {
    try {
      const store = sql`response = ${response}, completed_at = input.now,
            locked_by = null, locked_until = null, expires_at = input.now + ${interval(ttlMs)}`;
      const rows = rowsOf(
        await db.execute(
          keys.length === 1
            ? sql`
          with input as (select ${now()} as now)
          update ${table} as t set ${store}
          from input
          where t.key = ${keys[0]} and t.locked_by = ${token}
          returning 1`
            : sql`
          with input as (select ${now()} as now),
          ${lockMine(keys, token)},
          held as (select count(*) = ${keys.length}::int as every from mine)
          update ${table} as t set ${store}
          from input, held
          where t.key in (select key from mine) and held.every
          returning 1`,
        ),
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
  async function release(keys: readonly string[], token: string): Promise<void> {
    try {
      await db.execute(
        keys.length === 1
          ? sql`delete from ${table} where key = ${keys[0]} and locked_by = ${token}`
          : sql`with ${lockMine(keys, token)}
            delete from ${table} where key in (select key from mine)`,
      );
    } catch (error) {
      logger.warn("Could not release an idempotency key; it frees itself when its lease ends.", {
        error: errorText(error),
      });
    }
  }

  /** What a request's fingerprint is made of; `identify` hashes it under each secret. */
  async function requestFingerprint(
    request: Request,
    custom: string | Uint8Array | undefined,
  ): Promise<FingerprintParts> {
    if (custom !== undefined) return ["custom", custom];
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
    return ["request", request.method.toUpperCase(), url.pathname + url.search, body];
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

      const identity = identify(
        "http",
        scope,
        clientKey,
        await requestFingerprint(request, custom),
      );
      const claim = await begin(identity, scope, ttlMs);
      if (claim.kind === "mismatch") return errorResponse("idempotency_key_reused");
      if (claim.kind === "in_progress") return errorResponse("idempotency_key_in_use");
      if (claim.kind === "completed") {
        const stored: unknown = JSON.parse(claim.response);
        if (isStoredResponse(stored)) return decodeResponse(stored);
        // Only a damaged row gets here. Never replay something that can't be rebuilt.
        return errorResponse("idempotency_key_reused");
      }

      const stop = holdLease(claim.keys, claim.token);
      let response: Response;
      let body: Uint8Array;
      try {
        response = await handler();
        if (response.status < 200 || response.status >= 400) {
          stop();
          await release(claim.keys, claim.token);
          return response;
        }
        body = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        stop();
        await release(claim.keys, claim.token);
        throw error;
      }
      stop();
      await complete(
        claim.keys,
        claim.token,
        JSON.stringify(encodeResponse(response, body)),
        ttlMs,
      );
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
      const identity = identify(
        "run",
        scope,
        input.key,
        custom === undefined ? ["none"] : ["custom", custom],
      );

      const claim = await begin(identity, scope, ttlMs);
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

      const stop = holdLease(claim.keys, claim.token);
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
        await release(claim.keys, claim.token);
        throw error;
      }
      stop();
      await complete(claim.keys, claim.token, text, ttlMs);
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
                -- Rows a claim is taking over are skipped, not waited for: a claim under several
                -- secrets holds some of its rows while it takes the others, so waiting could deadlock.
                for update of e skip locked
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
