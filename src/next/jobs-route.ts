import { randomBytes } from "node:crypto";
import { hmacSha256, timingSafeEqual } from "../internal/crypto.ts";
import { GroundworkError } from "../internal/errors.ts";
import type { Jobs } from "../jobs/types.ts";

export interface JobsRouteOptions {
  /**
   * The bearer token callers must send (`Authorization: Bearer <secret>`), at least 16
   * characters. On Vercel, name it `CRON_SECRET` and Vercel Cron sends it for you.
   */
  readonly secret: string;
  /** Stop claiming new jobs after this long, then wait for running ones. Defaults to 10,000 ms. */
  readonly budgetMs?: number | undefined;
  /** Jobs run at once. Defaults to 4. */
  readonly concurrency?: number | undefined;
}

const MIN_SECRET_LENGTH = 16;

function unauthorized(): Response {
  return Response.json(
    { error: { code: "unauthorized", message: "Send the jobs secret as a Bearer token." } },
    { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } },
  );
}

/**
 * An HTTP trigger for `gw.jobs.runOnce()`, for cron services and serverless hosts where nothing
 * runs `gw.jobs.work()`. Export it as both GET (what Vercel Cron sends) and POST:
 *
 * ```ts
 * // app/api/jobs/route.ts
 * import "@/lib/jobs"; // the file that defines your jobs and schedules
 * export const maxDuration = 60;
 * export const GET = jobsRoute(gw, { secret: env.CRON_SECRET });
 * export const POST = GET;
 * ```
 *
 * Responds with the run's summary (`{ claimed, completed, retried, failed, scheduled, durationMs }`).
 * `?schedule=<name>` makes that schedule due first, like `gw.jobs.trigger(name)`.
 */
export function jobsRoute(
  modules: { readonly jobs: Jobs },
  options: JobsRouteOptions,
): (request: Request) => Promise<Response> {
  if (typeof modules !== "object" || modules === null) {
    throw new GroundworkError(
      "invalid_config",
      "jobsRoute needs your groundwork instance: jobsRoute(gw, …).",
    );
  }
  const secret = options?.secret;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || /\s/.test(secret)) {
    throw new GroundworkError(
      "invalid_config",
      `jobsRoute needs a secret of at least ${MIN_SECRET_LENGTH} characters, without spaces. Generate one with: openssl rand -base64 32`,
    );
  }
  const { budgetMs, concurrency } = options;
  // Compare digests, so the comparison takes the same time whatever the presented token's length.
  const compareKey = randomBytes(32);
  const expected = hmacSha256(compareKey, secret);

  return async (request) => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    const presented = hmacSha256(compareKey, match?.[1] ?? "");
    if (!match || !timingSafeEqual(presented, expected)) return unauthorized();

    const jobs = modules.jobs;
    const schedule = new URL(request.url).searchParams.get("schedule");
    if (schedule !== null && !(await jobs.trigger(schedule))) {
      return Response.json(
        { error: { code: "unknown_schedule", message: "No schedule with that name is defined." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const summary = await jobs.runOnce({
      ...(budgetMs === undefined ? {} : { budgetMs }),
      ...(concurrency === undefined ? {} : { concurrency }),
    });
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  };
}
