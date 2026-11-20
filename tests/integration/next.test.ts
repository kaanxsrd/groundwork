import { describe, expect, test } from "bun:test";
import { createGroundwork } from "../../src/index.ts";
import { createRouteHelpers, jobsRoute } from "../../src/next/index.ts";
import {
  apiKeys,
  auditLog,
  idempotencyKeys,
  jobSchedules,
  jobs,
  rateLimits,
} from "../fixtures/schema.ts";
import { useTestDatabase } from "../support/database.ts";
import { recordingLogger, TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
const CRON_SECRET = "cron-secret-for-tests-0123456789";

function setup() {
  const logger = recordingLogger();
  const gw = createGroundwork({
    db: database.current.db,
    tables: { apiKeys, auditLog, idempotencyKeys, jobs, jobSchedules, rateLimits },
    secret: TEST_SECRET,
    logger,
    audit: { actions: ["post.create"] },
    apiKeys: { namespace: "tst", scopes: { "posts:read": "Read", "posts:write": "Write" } },
    jobs: { rateLimitCleanup: false, idempotencyCleanup: false },
  });
  const helpers = createRouteHelpers(gw, { trustProxy: { header: "x-forwarded-for", hops: 1 } });
  return { gw, logger, ...helpers };
}

const context = { params: Promise.resolve({}) };

function request(
  key: string | null,
  init: { idempotencyKey?: string; body?: string; ip?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  if (init.ip) headers["x-forwarded-for"] = `198.51.100.1, ${init.ip}`;
  return new Request("https://app.example.test/api/posts", {
    method: "POST",
    headers,
    body: init.body ?? '{"title":"Hello"}',
  });
}

describe("route helpers with a real groundwork instance", () => {
  test("API key, per-key rate limit and idempotency, composed", async () => {
    const { gw, withApiKey, withRateLimit, withIdempotency } = setup();
    const { key } = await gw.apiKeys.create({
      name: "writer",
      scopes: ["posts:write"],
      rateLimit: null,
    });
    const { key: reader } = await gw.apiKeys.create({ name: "reader", scopes: ["posts:read"] });
    const writes = gw.rateLimit.rule({ name: unique("posts:write"), limit: 3, window: "1m" });
    let created = 0;
    const POST = withApiKey(
      ["posts:write"],
      withRateLimit(
        writes,
        (_request, { apiKey }) => apiKey.id,
        withIdempotency(
          { scope: (_request, { apiKey }) => `apikey:${apiKey.id}` },
          async (req, { apiKey }) => {
            const input = (await req.json()) as { title: string };
            created++;
            await gw.audit.record({
              actor: { type: "api_key", id: apiKey.id },
              action: "post.create",
              metadata: { title: input.title },
            });
            return Response.json({ id: `post_${created}`, title: input.title }, { status: 201 });
          },
        ),
      ),
    );

    expect((await POST(request(null), context)).status).toBe(401);
    const forbidden = await POST(request(reader), context);
    expect(forbidden.status).toBe(403);

    const first = await POST(request(key, { idempotencyKey: "post-key-0001" }), context);
    const retry = await POST(request(key, { idempotencyKey: "post-key-0001" }), context);
    expect([first.status, retry.status]).toEqual([201, 201]);
    expect(await retry.json()).toEqual(await first.json());
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    // Every request through the limiter counts, replays included: 2 of 3 used.
    expect(first.headers.get("ratelimit")).toContain("r=2");
    expect(retry.headers.get("ratelimit")).toContain("r=1");
    expect(created).toBe(1);

    expect((await POST(request(key), context)).status).toBe(201);
    const limited = await POST(request(key), context);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(created).toBe(2);

    const entries = await gw.audit.query({ action: "post.create" });
    expect(entries.entries).toHaveLength(2);
  });

  test("API-key IP allowlists use the trusted proxy header", async () => {
    const { gw, withApiKey } = setup();
    const { key } = await gw.apiKeys.create({
      name: "office only",
      scopes: ["posts:read"],
      allowedIps: ["203.0.113.0/24"],
    });
    const GET = withApiKey(["posts:read"], async (_request, { apiKey }) =>
      Response.json({ id: apiKey.id }),
    );
    expect((await GET(request(key, { ip: "203.0.113.50" }), context)).status).toBe(200);
    // The client's own X-Forwarded-For entry (198.51.100.1) is never trusted.
    expect((await GET(request(key, { ip: "198.51.100.9" }), context)).status).toBe(403);
    expect((await GET(request(key), context)).status).toBe(403);
  });

  test("jobsRoute runs due jobs and schedules", async () => {
    const { gw } = setup();
    const type = unique("email.welcome");
    const sent: string[] = [];
    const welcome = gw.jobs.define(type, {
      async run(payload: { to: string }) {
        sent.push(payload.to);
      },
    });
    let ticks = 0;
    const schedule = unique("digest");
    gw.jobs.schedule(schedule, { every: "1h" }, () => {
      ticks++;
    });
    await welcome.enqueue({ to: "a@example.test" });
    const route = jobsRoute(gw, { secret: CRON_SECRET, budgetMs: 5_000 });
    const call = (query = "", auth = `Bearer ${CRON_SECRET}`) =>
      route(
        new Request(`https://app.example.test/api/jobs${query}`, {
          headers: { authorization: auth },
        }),
      );

    expect((await call("", "Bearer wrong-secret-0123456789")).status).toBe(401);
    const first = await call();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ completed: 2, failed: 0, scheduled: 1 });
    expect([sent, ticks]).toEqual([["a@example.test"], 1]);

    // Not due again for an hour, unless triggered.
    expect(await (await call()).json()).toMatchObject({ completed: 0 });
    expect(await (await call(`?schedule=${schedule}`)).json()).toMatchObject({ completed: 1 });
    expect(ticks).toBe(2);
    expect((await call("?schedule=missing")).status).toBe(404);
  });
});
