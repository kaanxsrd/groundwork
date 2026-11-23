/**
 * `@vantedev/groundwork/next`: route-handler helpers for Next.js. They only use the Web `Request` and
 * `Response`, so they also work in any framework with the same handler shape.
 *
 * ```ts
 * // lib/route.ts
 * import { createRouteHelpers } from "@vantedev/groundwork/next";
 * export const { withApiKey, withRateLimit, withIdempotency, clientIp } =
 *   createRouteHelpers(gw, { trustProxy: "vercel" });
 *
 * // app/api/posts/route.ts
 * export const POST = withApiKey(
 *   ["posts:write"],
 *   withIdempotency({ scope: (_request, { apiKey }) => `apikey:${apiKey.id}` }, async (request) =>
 *     Response.json(await createPost(await request.json()), { status: 201 }),
 *   ),
 * );
 *
 * // app/api/jobs/route.ts
 * export const GET = jobsRoute(gw, { secret: env.CRON_SECRET });
 * export const POST = GET;
 * ```
 *
 * @module @vantedev/groundwork/next
 */
export { type ClientIpOptions, getClientIp, type TrustProxy } from "./client-ip.ts";
export { type JobsRouteOptions, jobsRoute } from "./jobs-route.ts";
export {
  type ApiKeyContext,
  createRouteHelpers,
  type DefaultRouteContext,
  type RateLimitKey,
  type RouteHandler,
  type RouteHelperModules,
  type RouteHelpers,
  type RouteHelpersOptions,
  type WithIdempotencyOptions,
} from "./route-helpers.ts";
