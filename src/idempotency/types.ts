import type { Duration } from "../internal/duration.ts";

/**
 * What `T` becomes after a trip through JSON: `Date` becomes `string`, properties that hold
 * functions, symbols or `undefined` disappear (in arrays they become `null`), and objects with
 * `toJSON()` become what it returns. `run()` returns this type, because a replayed result is read
 * back from JSON.
 */
export type Jsonify<T> = unknown extends T
  ? unknown
  : T extends { toJSON(...args: never[]): infer J }
    ? Jsonify<J>
    : T extends string | number | boolean | null
      ? T
      : T extends bigint
        ? never
        : T extends Dropped
          ? undefined
          : T extends readonly unknown[]
            ? { -readonly [K in keyof T]: JsonifyItem<T[K]> }
            : T extends object
              ? JsonObject<T>
              : never;

// biome-ignore lint/suspicious/noConfusingVoidType: a `void` function's result is stored as undefined.
type Dropped = undefined | void | symbol | ((...args: never[]) => unknown);

/** In arrays, values JSON can't hold become `null`. Distributes over unions. */
type JsonifyItem<V> = V extends Dropped ? null : Jsonify<V>;

/** Keys whose value can be dropped become optional; keys that are always dropped disappear. */
type JsonObject<T> = Simplify<
  {
    -readonly [K in keyof T as K extends string
      ? [Exclude<T[K], Dropped>] extends [never]
        ? never
        : [Extract<T[K], Dropped>] extends [never]
          ? K
          : never
      : never]: Jsonify<T[K]>;
  } & {
    -readonly [K in keyof T as K extends string
      ? [Exclude<T[K], Dropped>] extends [never]
        ? never
        : [Extract<T[K], Dropped>] extends [never]
          ? never
          : K
      : never]?: Jsonify<Exclude<T[K], Dropped>>;
  }
>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export interface HandleOptions {
  /**
   * Whose keys these are, such as `` `apikey:${key.id}` `` or `` `user:${user.id}` ``. Keys never
   * match across scopes, so one client can't replay another's response.
   */
  readonly scope: string;
  /** Reject requests without an `Idempotency-Key` header (400). Defaults to `false`: they run unprotected. */
  readonly required?: boolean | undefined;
  /** How long a completed response is replayed. Defaults to the module's `ttl`. */
  readonly ttl?: Duration | undefined;
  /**
   * What identifies the request, instead of its method, path and body. Pass it when you've already
   * read the body, for example the validated input as JSON.
   */
  readonly fingerprint?: string | Uint8Array | undefined;
}

export interface RunInput {
  /** Whose key it is, such as `"stripe"` for webhook event ids or `` `user:${id}` ``. */
  readonly scope: string;
  /** The idempotency key: a webhook event id, a client-supplied key… 1 to 255 characters. */
  readonly key: string;
  /**
   * What the key was first used for. When given, a later call with the same key and a different
   * fingerprint gets `{ ok: false, reason: "mismatch" }`. Defaults to none: any call replays.
   */
  readonly fingerprint?: string | Uint8Array | undefined;
  /** How long the result is replayed. Defaults to the module's `ttl`. */
  readonly ttl?: Duration | undefined;
}

export type RunResult<T> =
  | {
      readonly ok: true;
      /** The function's result, as stored: the same value on the first call and every replay. */
      readonly value: T;
      /** `true` when this is a stored result and the function did not run. */
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      /**
       * - `mismatch`: the key was already used with a different fingerprint.
       * - `in_progress`: the first call with this key is still running.
       */
      readonly reason: "mismatch" | "in_progress";
    };

export interface Idempotency {
  /**
   * Makes an HTTP handler safe to retry, following draft-ietf-httpapi-idempotency-key-header:
   *
   * - no `Idempotency-Key`: runs `handler` (or 400 when `required`);
   * - a key seen for the first time: runs `handler` and stores a 2xx or 3xx response;
   * - the same key and request again: replays the stored response with `Idempotent-Replayed: true`;
   * - the same key with a different request: 422;
   * - the same key while the first request is still running: 409.
   *
   * Errors (4xx, 5xx or a throw) are not stored, so the client can retry with the same key. The
   * request's body is read from a clone, so `handler` can still read it.
   */
  handle(
    request: Request,
    options: HandleOptions,
    handler: () => Response | Promise<Response>,
  ): Promise<Response>;
  /**
   * Runs `fn` at most once per scope and key, and returns its result again on every later call.
   * For webhooks, server actions and anything else that isn't an HTTP handler, or to store only
   * part of a response. If `fn` throws, nothing is stored and the next call runs it again.
   */
  run<T>(input: RunInput, fn: () => T | Promise<T>): Promise<RunResult<Jsonify<Awaited<T>>>>;
  /** Deletes expired keys. Run it every hour or so; returns how many rows it deleted. */
  cleanup(): Promise<number>;
}
