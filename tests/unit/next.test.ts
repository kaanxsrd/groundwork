import { describe, expect, test } from "bun:test";
import type { ApiKeyRecord, ApiKeys, VerifyOptions } from "../../src/api-keys/types.ts";
import type { Idempotency } from "../../src/idempotency/types.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";
import type { Jobs, RunOnceOptions, RunSummary } from "../../src/jobs/types.ts";
import {
  createRouteHelpers,
  type DefaultRouteContext,
  getClientIp,
  jobsRoute,
  type TrustProxy,
} from "../../src/next/index.ts";
import type { RateLimitResult, RateLimitRule } from "../../src/rate-limit/types.ts";

type Scope = "posts:read" | "posts:write";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isGroundworkError(error) ? error.code : `not a GroundworkError: ${String(error)}`;
  }
  return undefined;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return isGroundworkError(error) ? error.code : `not a GroundworkError: ${String(error)}`;
  }
  return undefined;
}

const context: DefaultRouteContext = { params: Promise.resolve({}) };

function headersWith(name: string, value: string): Headers {
  return new Headers({ [name]: value });
}

describe("getClientIp", () => {
  const spoofed = new Headers({
    "x-forwarded-for": "198.51.100.1",
    "x-real-ip": "198.51.100.2",
    "cf-connecting-ip": "198.51.100.3",
  });

  test("trusts no header by default", () => {
    expect(getClientIp(spoofed)).toBeNull();
    expect(getClientIp(spoofed, { trustProxy: "none" })).toBeNull();
    expect(getClientIp(new Request("https://example.test", { headers: spoofed }))).toBeNull();
  });

  test("reads only the header the preset names", () => {
    expect(getClientIp(spoofed, { trustProxy: "vercel" })).toBe("198.51.100.2");
    expect(getClientIp(spoofed, { trustProxy: "cloudflare" })).toBe("198.51.100.3");
    expect(getClientIp(new Headers(), { trustProxy: "vercel" })).toBeNull();
  });

  test("counts hops from the right of X-Forwarded-For, where trusted proxies append", () => {
    const xff = headersWith("x-forwarded-for", "203.0.113.9, 198.51.100.7, 10.0.0.2");
    const via = (hops: number): TrustProxy => ({ header: "X-Forwarded-For", hops });
    expect(getClientIp(xff, { trustProxy: via(1) })).toBe("10.0.0.2");
    expect(getClientIp(xff, { trustProxy: via(2) })).toBe("198.51.100.7");
    expect(getClientIp(xff, { trustProxy: via(3) })).toBe("203.0.113.9");
    // Fewer entries than proxies: someone skipped a proxy, so nothing here can be trusted.
    expect(getClientIp(xff, { trustProxy: via(4) })).toBeNull();
    expect(getClientIp(xff, { trustProxy: { header: "x-forwarded-for" } })).toBe("10.0.0.2");
  });

  test("normalises addresses and drops ports", () => {
    const ip = (value: string) =>
      getClientIp(headersWith("x-real-ip", value), { trustProxy: "vercel" });
    expect(ip(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(ip("203.0.113.7:4711")).toBe("203.0.113.7");
    expect(ip("[2001:DB8:0:0::1]:443")).toBe("2001:db8::1");
    expect(ip("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(ip("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ip("unknown")).toBeNull();
    expect(ip("203.0.113.256")).toBeNull();
    expect(ip("")).toBeNull();
  });

  test("rejects a trustProxy it can't use, instead of silently returning null", () => {
    for (const bad of [
      "x-forwarded-for",
      { header: "bad header" },
      { header: "x-forwarded-for", hops: 0 },
      { header: "x-forwarded-for", hops: 1.5 },
      { header: "x-forwarded-for", hops: 21 },
      null,
    ]) {
      expect(codeOf(() => getClientIp(new Headers(), { trustProxy: bad as never }))).toBe(
        "invalid_config",
      );
    }
  });
});

function fakeKey(): ApiKeyRecord<Scope> {
  return {
    id: "key-1",
    ownerId: "user-1",
    scopes: ["posts:read"],
  } as unknown as ApiKeyRecord<Scope>;
}

function fakeApiKeys(ok: boolean) {
  const calls: { scopes: readonly string[] | undefined; ip: string | null | undefined }[] = [];
  const apiKeys = {
    async verify(_input: unknown, options?: VerifyOptions<Scope>) {
      calls.push({ scopes: options?.scopes, ip: options?.ip });
      if (ok) {
        return {
          ok: true,
          key: fakeKey(),
          headers: { RateLimit: '"api";r=59;t=60' },
          rateLimit: null,
          quota: null,
        };
      }
      return {
        ok: false,
        response: Response.json({ error: { code: "missing" } }, { status: 401 }),
      };
    },
  } as unknown as ApiKeys<Scope>;
  return { apiKeys, calls };
}

function fakeRule(allowed: boolean): RateLimitRule & { subjects: string[] } {
  const subjects: string[] = [];
  return {
    name: "test",
    algorithm: "fixed-window",
    subjects,
    async check(subject: string): Promise<RateLimitResult> {
      subjects.push(subject);
      return {
        allowed,
        limit: 5,
        remaining: allowed ? 4 : 0,
        resetAt: new Date(0),
        retryAfterMs: allowed ? 0 : 1_500,
        headers: allowed
          ? { RateLimit: '"test";r=4;t=60' }
          : { RateLimit: '"test";r=0;t=2', "Retry-After": "2" },
        degraded: false,
      };
    },
    async reset() {},
  };
}

describe("createRouteHelpers", () => {
  const request = () =>
    new Request("https://example.test/api/posts", {
      method: "POST",
      headers: { "x-real-ip": "203.0.113.7", authorization: "Bearer x" },
    });

  test("withApiKey passes the key to the handler and adds its rate-limit headers", async () => {
    const { apiKeys, calls } = fakeApiKeys(true);
    const { withApiKey } = createRouteHelpers({ apiKeys }, { trustProxy: "vercel" });
    const route = withApiKey(["posts:read"], async (_request, { apiKey, params }) => {
      await params;
      return Response.json({ id: apiKey.id }, { headers: { RateLimit: "handler's own" } });
    });
    const response = await route(request(), context);
    expect(await response.json()).toEqual({ id: "key-1" });
    // The handler's own header wins; the IP comes from the trusted header only.
    expect(response.headers.get("ratelimit")).toBe("handler's own");
    expect(calls).toEqual([{ scopes: ["posts:read"], ip: "203.0.113.7" }]);
  });

  test("withApiKey returns verify's response on failure, without running the handler", async () => {
    const { apiKeys } = fakeApiKeys(false);
    const { withApiKey } = createRouteHelpers({ apiKeys });
    let ran = false;
    const route = withApiKey([], () => {
      ran = true;
      return new Response("no");
    });
    expect((await route(request(), context)).status).toBe(401);
    expect(ran).toBe(false);
  });

  test("withApiKey without a trusted proxy sends no IP, so allowlisted keys are denied", async () => {
    const { apiKeys, calls } = fakeApiKeys(true);
    const { withApiKey } = createRouteHelpers({ apiKeys });
    await withApiKey([], () => new Response("ok"))(request(), context);
    expect(calls[0]?.ip).toBeNull();
  });

  test("withRateLimit answers 429 over the limit and adds headers under it", async () => {
    const { withRateLimit } = createRouteHelpers({});
    const denied = fakeRule(false);
    const route = withRateLimit(
      denied,
      () => "user-1",
      () => new Response("ran"),
    );
    const response = await route(request(), context);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests. Try again in 2 seconds." },
    });

    const allowed = fakeRule(true);
    const ok = await withRateLimit(
      allowed,
      () => "user-1",
      () => new Response("ran"),
    )(request(), context);
    expect([ok.status, await ok.text(), ok.headers.get("ratelimit")]).toEqual([
      200,
      "ran",
      '"test";r=4;t=60',
    ]);
    expect(allowed.subjects).toEqual(["user-1"]);
  });

  test("withRateLimit lets a request through unlimited when the key is null", async () => {
    const { withRateLimit } = createRouteHelpers({});
    const rule = fakeRule(false);
    const route = withRateLimit(
      rule,
      () => null,
      () => new Response("ran"),
    );
    expect(await (await route(request(), context)).text()).toBe("ran");
    expect(rule.subjects).toEqual([]);
  });

  test("withRateLimit adds headers to responses whose headers are immutable", async () => {
    const { withRateLimit } = createRouteHelpers({});
    const route = withRateLimit(
      fakeRule(true),
      () => "s",
      () => Response.redirect("https://example.test/elsewhere", 303),
    );
    const response = await route(request(), context);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.test/elsewhere");
    expect(response.headers.get("ratelimit")).toBe('"test";r=4;t=60');
  });

  test("withIdempotency resolves the scope from the request and context", async () => {
    const seen: string[] = [];
    const idempotency = {
      async handle(
        _request: Request,
        options: { scope: string },
        handler: () => Promise<Response>,
      ) {
        seen.push(options.scope);
        return handler();
      },
    } as unknown as Idempotency;
    const { withApiKey, withIdempotency } = createRouteHelpers({
      apiKeys: fakeApiKeys(true).apiKeys,
      idempotency,
    });
    const route = withApiKey(
      ["posts:write"],
      withIdempotency(
        { scope: (_request, { apiKey }) => `apikey:${apiKey.id}`, required: true },
        async (_request, { apiKey }) => new Response(apiKey.id),
      ),
    );
    expect(await (await route(request(), context)).text()).toBe("key-1");
    expect(seen).toEqual(["apikey:key-1"]);
  });

  test("helpers whose module is missing fail when used, not when created", async () => {
    const helpers = createRouteHelpers({});
    const route = helpers.withApiKey([], () => new Response("ok"));
    let caught: unknown;
    try {
      await route(request(), context);
    } catch (error) {
      caught = error;
    }
    expect(isGroundworkError(caught) && caught.code).toBe("invalid_config");
    expect(codeOf(() => createRouteHelpers(undefined as never))).toBe("invalid_config");
    expect(
      codeOf(() =>
        helpers.withRateLimit(
          {} as never,
          () => "s",
          () => new Response(),
        ),
      ),
    ).toBe("invalid_argument");
    expect(codeOf(() => helpers.withApiKey("posts:read" as never, () => new Response()))).toBe(
      "invalid_argument",
    );
  });

  test("route handlers type-check as Next.js expects", () => {
    const { withApiKey, withRateLimit, withIdempotency } = createRouteHelpers({
      apiKeys: fakeApiKeys(true).apiKeys,
    });
    // What Next.js 16 generates for app/posts/[id]/route.ts (NextRequest extends Request).
    type NextRequestLike = Request & { readonly nextUrl: URL };
    type RouteHandlerConfig = {
      POST?: (
        request: NextRequestLike,
        context: { params: Promise<{ id: string }> },
      ) => Promise<Response | undefined> | Response | undefined;
      GET?: (
        request: NextRequestLike,
        context: { params: Promise<{ slug?: string[] }> },
      ) => Promise<Response | undefined> | Response | undefined;
    };
    const rule = fakeRule(true);
    const POST = withApiKey(
      ["posts:write"],
      withRateLimit(
        rule,
        (_request, { apiKey }) => apiKey.id,
        withIdempotency(
          { scope: (_request, { apiKey }) => `apikey:${apiKey.id}` },
          async (_request, { apiKey, params }) =>
            Response.json({ key: apiKey.id, ...(await params) }),
        ),
      ),
    );
    const GET = withApiKey(["posts:read"], async () => new Response("ok"));
    const typed = withApiKey<{ params: Promise<{ id: string }> }>(
      ["posts:read"],
      async (_request, { params }) => new Response((await params).id),
    );
    const config: RouteHandlerConfig = { POST, GET };
    const typedConfig: RouteHandlerConfig = { POST: typed };
    // @ts-expect-error not a declared scope
    withApiKey(["posts:delete"], async () => new Response());
    expect([config, typedConfig]).toHaveLength(2);
  });
});

function fakeJobs() {
  const runs: RunOnceOptions[] = [];
  const triggered: string[] = [];
  const summary: RunSummary = {
    claimed: 1,
    completed: 1,
    retried: 0,
    failed: 0,
    scheduled: 0,
    durationMs: 3,
  };
  const jobs = {
    async runOnce(options: RunOnceOptions) {
      runs.push(options);
      return summary;
    },
    async trigger(name: string) {
      triggered.push(name);
      return name === "known";
    },
  } as unknown as Jobs;
  return { jobs, runs, triggered, summary };
}

describe("jobsRoute", () => {
  const SECRET = "cron-secret-0123456789";
  const call = (route: (request: Request) => Promise<Response>, auth?: string, query = "") =>
    route(
      new Request(`https://example.test/api/jobs${query}`, {
        headers: auth === undefined ? {} : { authorization: auth },
      }),
    );

  test("needs a real secret", () => {
    const { jobs } = fakeJobs();
    for (const secret of [undefined, "", "short", "has spaces in the secret", 5]) {
      expect(codeOf(() => jobsRoute({ jobs }, { secret: secret as never }))).toBe("invalid_config");
    }
    expect(codeOf(() => jobsRoute(undefined as never, { secret: SECRET }))).toBe("invalid_config");
  });

  test("checks budget and concurrency when it's created, not on every cron call", () => {
    const { jobs } = fakeJobs();
    for (const budget of ["0s", "fast", 5000]) {
      expect(codeOf(() => jobsRoute({ jobs }, { secret: SECRET, budget: budget as never }))).toBe(
        "invalid_config",
      );
    }
    for (const concurrency of [0, -1, 1.5, "4"]) {
      expect(
        codeOf(() => jobsRoute({ jobs }, { secret: SECRET, concurrency: concurrency as never })),
      ).toBe("invalid_config");
    }
    // 0.x's budgetMs would otherwise be ignored without a word.
    expect(codeOf(() => jobsRoute({ jobs }, { secret: SECRET, budgetMs: 5000 } as never))).toBe(
      "invalid_config",
    );
  });

  test("a secret function is read on the first request, so next build doesn't need it", async () => {
    const { jobs, runs } = fakeJobs();
    let reads = 0;
    let value: string | undefined;
    const route = jobsRoute(
      { jobs },
      {
        secret: () => {
          reads++;
          return value ?? "";
        },
      },
    );
    expect(reads).toBe(0);
    value = SECRET;
    expect((await call(route, `Bearer ${SECRET}`)).status).toBe(200);
    expect((await call(route, `Bearer ${SECRET}`)).status).toBe(200);
    expect(reads).toBe(1);
    expect(runs).toHaveLength(2);

    const unset = jobsRoute({ jobs }, { secret: () => "" });
    expect(await codeOfAsync(() => call(unset, `Bearer ${SECRET}`))).toBe("invalid_config");
  });

  test("rejects requests without the bearer secret", async () => {
    const { jobs, runs } = fakeJobs();
    const route = jobsRoute({ jobs }, { secret: SECRET });
    for (const auth of [
      undefined,
      "",
      SECRET,
      `Basic ${SECRET}`,
      `Bearer ${SECRET}x`,
      "Bearer x",
    ]) {
      const response = await call(route, auth);
      expect([auth, response.status]).toEqual([auth, 401]);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(runs).toHaveLength(0);
  });

  test("runs due jobs once and returns the summary", async () => {
    const { jobs, runs, summary } = fakeJobs();
    const route = jobsRoute({ jobs }, { secret: SECRET, budget: "5s", concurrency: 2 });
    const response = await call(route, `bearer   ${SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(summary);
    expect(runs).toEqual([{ budget: "5s", concurrency: 2 }]);
  });

  test("?schedule= makes that schedule due first, and 404s for unknown ones", async () => {
    const { jobs, runs, triggered } = fakeJobs();
    const route = jobsRoute({ jobs }, { secret: SECRET });
    expect((await call(route, `Bearer ${SECRET}`, "?schedule=known")).status).toBe(200);
    const unknown = await call(route, `Bearer ${SECRET}`, "?schedule=nope");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "unknown_schedule",
    );
    expect(triggered).toEqual(["known", "nope"]);
    expect(runs).toEqual([{}]);
  });
});
