import type { ApiKeyRecord, ApiKeys } from "../api-keys/types.ts";
import type { HandleOptions, Idempotency } from "../idempotency/types.ts";
import { GroundworkError } from "../internal/errors.ts";
import type { RateLimitRule } from "../rate-limit/types.ts";
import { clientIpFrom, resolveTrustProxy, type TrustProxy } from "./client-ip.ts";
import { withHeaders } from "./response.ts";

/**
 * The second argument Next.js passes a route handler. Use your route's own type for typed params:
 * `withApiKey<RouteContext<"/posts/[id]">>(…)`.
 */
export interface DefaultRouteContext {
  readonly params: Promise<Record<string, string | string[] | undefined>>;
}

/** A Next.js route handler: `export const POST: RouteHandler = …`. */
export type RouteHandler<TContext = DefaultRouteContext, TRequest extends Request = Request> = (
  request: TRequest,
  context: TContext,
) => Response | Promise<Response>;

/** What `withApiKey` adds to the context. */
export interface ApiKeyContext<TScope extends string = string> {
  readonly apiKey: ApiKeyRecord<TScope>;
}

/** The modules the helpers use: pass `gw` from `createGroundwork`, or your own modules. */
export interface RouteHelperModules<TScope extends string = string> {
  readonly apiKeys?: ApiKeys<TScope> | undefined;
  readonly idempotency?: Idempotency | undefined;
}

export interface RouteHelpersOptions {
  /** Where the client's IP comes from, for API-key allowlists and `clientIp()`. Defaults to `"none"`. */
  readonly trustProxy?: TrustProxy | undefined;
}

export interface WithIdempotencyOptions<TContext, TRequest extends Request>
  extends Omit<HandleOptions, "scope"> {
  /** Whose keys these are, or a function that works it out from the request. */
  readonly scope: string | ((request: TRequest, context: TContext) => string | Promise<string>);
}

/** Returns a subject to limit by, or `null`/`undefined` to let this request through unlimited. */
export type RateLimitKey<TContext, TRequest extends Request> = (
  request: TRequest,
  context: TContext,
) => string | null | undefined | Promise<string | null | undefined>;

export interface RouteHelpers<TScope extends string> {
  /**
   * Requires an API key with every scope in `scopes`. Failures get the JSON 401, 403 or 429 from
   * `verify`; the key reaches the handler as `context.apiKey`, and its rate-limit headers are added
   * to the response. Wrappers nested inside see `apiKey` too.
   */
  withApiKey<TRequest extends Request = Request>(
    scopes: readonly TScope[],
    handler: RouteHandler<DefaultRouteContext & ApiKeyContext<TScope>, TRequest>,
  ): (request: TRequest, context: DefaultRouteContext) => Promise<Response>;
  /** With your route's context type, for typed params: `withApiKey<RouteContext<"/posts/[id]">>(…)`. */
  withApiKey<TContext, TRequest extends Request = Request>(
    scopes: readonly TScope[],
    handler: RouteHandler<TContext & ApiKeyContext<TScope>, TRequest>,
  ): (request: TRequest, context: TContext) => Promise<Response>;
  /**
   * Checks `rule` for the subject `key` returns. Over the limit: a JSON 429 with `Retry-After` and
   * `RateLimit` headers. Otherwise the rate-limit headers are added to the handler's response.
   */
  withRateLimit<TContext = DefaultRouteContext, TRequest extends Request = Request>(
    rule: RateLimitRule,
    key: RateLimitKey<TContext, TRequest>,
    handler: RouteHandler<TContext, TRequest>,
  ): (request: TRequest, context: TContext) => Promise<Response>;
  /** Makes the handler safe to retry with an `Idempotency-Key` header. See `Idempotency.handle`. */
  withIdempotency<TContext = DefaultRouteContext, TRequest extends Request = Request>(
    options: WithIdempotencyOptions<TContext, TRequest>,
    handler: RouteHandler<TContext, TRequest>,
  ): (request: TRequest, context: TContext) => Promise<Response>;
  /** The client's IP, from the header `trustProxy` names, or `null`. */
  clientIp(input: Request | Headers): string | null;
}

/** The JSON 429 `withRateLimit` sends. */
function rateLimited(headers: Readonly<Record<string, string>>, retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  return Response.json(
    {
      error: {
        code: "rate_limited",
        message: `Too many requests. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      },
    },
    { status: 429, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

/**
 * Route-handler wrappers bound to your groundwork instance and proxy setup. Create them once:
 *
 * ```ts
 * // lib/route.ts
 * export const { withApiKey, withRateLimit, withIdempotency, clientIp } =
 *   createRouteHelpers(gw, { trustProxy: "vercel" });
 *
 * // app/api/posts/route.ts
 * export const POST = withApiKey(["posts:write"], async (request, { apiKey }) => {
 *   return Response.json(await createPost(apiKey.ownerId, await request.json()), { status: 201 });
 * });
 * ```
 */
export function createRouteHelpers<TScope extends string = string>(
  modules: RouteHelperModules<TScope>,
  options: RouteHelpersOptions = {},
): RouteHelpers<TScope> {
  if (typeof modules !== "object" || modules === null) {
    throw new GroundworkError(
      "invalid_config",
      "createRouteHelpers needs your groundwork instance: createRouteHelpers(gw).",
    );
  }
  const source = resolveTrustProxy(options.trustProxy);
  const clientIp = (input: Request | Headers): string | null =>
    clientIpFrom(input instanceof Headers ? input : input.headers, source);

  // Read lazily: gw.apiKeys throws when API keys aren't configured, and that should only matter
  // to routes that use them.
  const apiKeys = (): ApiKeys<TScope> => {
    const value = modules.apiKeys;
    if (value === undefined) {
      throw new GroundworkError("invalid_config", "withApiKey needs gw.apiKeys to be configured.");
    }
    return value;
  };
  const idempotency = (): Idempotency => {
    const value = modules.idempotency;
    if (value === undefined) {
      throw new GroundworkError(
        "invalid_config",
        "withIdempotency needs gw.idempotency: export the idempotencyKeys table and pass it in tables.",
      );
    }
    return value;
  };

  // The overloads differ only in how the context is typed, so one implementation serves both.
  function withApiKey(
    scopes: readonly TScope[],
    handler: RouteHandler<object & ApiKeyContext<TScope>, Request>,
  ): (request: Request, context: object) => Promise<Response> {
    if (!Array.isArray(scopes)) {
      throw new GroundworkError("invalid_argument", "withApiKey needs an array of scopes first.");
    }
    const required = [...scopes];
    return async (request, context) => {
      const auth = await apiKeys().verify(request, { scopes: required, ip: clientIp(request) });
      if (!auth.ok) return auth.response;
      const response = await handler(request, { ...context, apiKey: auth.key });
      return withHeaders(response, auth.headers);
    };
  }

  return {
    clientIp,

    withApiKey: withApiKey as RouteHelpers<TScope>["withApiKey"],

    withRateLimit(rule, key, handler) {
      if (typeof rule?.check !== "function" || typeof key !== "function") {
        throw new GroundworkError(
          "invalid_argument",
          "withRateLimit(rule, key, handler) needs a rule from gw.rateLimit.rule() and a key function.",
        );
      }
      return async (request, context) => {
        const subject = await key(request, context);
        if (subject === null || subject === undefined) return handler(request, context);
        const result = await rule.check(subject);
        if (!result.allowed) return rateLimited(result.headers, result.retryAfterMs);
        return withHeaders(await handler(request, context), result.headers);
      };
    },

    withIdempotency(idempotencyOptions, handler) {
      if (typeof idempotencyOptions !== "object" || idempotencyOptions === null) {
        throw new GroundworkError(
          "invalid_argument",
          "withIdempotency needs options with a scope.",
        );
      }
      const { scope, ...rest } = idempotencyOptions;
      return async (request, context) => {
        const resolved = typeof scope === "function" ? await scope(request, context) : scope;
        return idempotency().handle(request, { ...rest, scope: resolved }, () =>
          handler(request, context),
        );
      };
    },
  };
}
