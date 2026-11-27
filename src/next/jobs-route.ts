import { randomBytes } from "node:crypto";
import { hmacSha256, timingSafeEqual } from "../internal/crypto.ts";
import { type Duration, parseDuration } from "../internal/duration.ts";
import { GroundworkError, isGroundworkError } from "../internal/errors.ts";
import type { Jobs } from "../jobs/types.ts";

export interface JobsRouteOptions {
  /**
   * The bearer token callers must send (`Authorization: Bearer <secret>`), at least 16
   * characters. On Vercel, name it `CRON_SECRET` and Vercel Cron sends it for you.
   *
   * A string is checked when the route is created. A function is called on the first request,
   * so `next build` works without the variable: `secret: () => process.env.CRON_SECRET ?? ""`.
   */
  readonly secret: string | (() => string);
  /** Stop claiming new jobs after this long, then wait for running ones. Defaults to `"10s"`. */
  readonly budget?: Duration | undefined;
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

function checkedSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || /\s/.test(secret)) {
    throw new GroundworkError(
      "invalid_config",
      `jobsRoute needs a secret of at least ${MIN_SECRET_LENGTH} characters, without spaces. Generate one with: openssl rand -base64 32`,
    );
  }
  return secret;
}

/**
 * An HTTP trigger for `gw.jobs.runOnce()`, for cron services and serverless hosts where nothing
 * runs `gw.jobs.work()`. Export it as both GET (what Vercel Cron sends) and POST:
 *
 * ```ts
 * // app/api/jobs/route.ts
 * import "@/lib/jobs"; // the file that defines your jobs and schedules
 * export const maxDuration = 60;
 * export const GET = jobsRoute(gw, { secret: () => env.CRON_SECRET, budget: "50s" });
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
  const source = options?.secret;
  if ((options as { budgetMs?: unknown } | undefined)?.budgetMs !== undefined) {
    throw new GroundworkError(
      "invalid_config",
      'jobsRoute takes budget, a duration such as "50s"; budgetMs was removed in 1.0.',
    );
  }
  // A typo here would otherwise turn every cron call into a 500, so check now.
  const { budget, concurrency } = options;
  if (budget !== undefined) {
    try {
      parseDuration(budget, { label: "budget", minMs: 1 });
    } catch (error) {
      if (!isGroundworkError(error)) throw error;
      throw new GroundworkError("invalid_config", `jobsRoute ${error.message}`);
    }
  }
  if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    throw new GroundworkError(
      "invalid_config",
      "jobsRoute concurrency must be a positive integer.",
    );
  }
  // Compare digests, so the comparison takes the same time whatever the presented token's length.
  const compareKey = randomBytes(32);
  let expected: Buffer | undefined;
  if (typeof source === "function") {
    // Checked on the first request instead.
  } else expected = hmacSha256(compareKey, checkedSecret(source));

  return async (request) => {
    expected ??= hmacSha256(compareKey, checkedSecret((source as () => string)()));
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
      ...(budget === undefined ? {} : { budget }),
      ...(concurrency === undefined ? {} : { concurrency }),
    });
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  };
}
