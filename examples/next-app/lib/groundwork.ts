import { createGroundwork } from "@vante/groundwork";
import { createRouteHelpers } from "@vante/groundwork/next";
import { db } from "@/db";
import * as tables from "@/db/schema/groundwork";
import { env } from "@/lib/env";

export const gw = createGroundwork({
  db,
  tables,
  secret: env.GROUNDWORK_SECRET,
  audit: {
    actions: ["post.create", "post.announce"],
    entityTypes: ["post"],
  },
  apiKeys: {
    namespace: "demo",
    scopes: {
      "posts:read": "List posts",
      "posts:write": "Create posts",
    },
  },
});

// The client's IP is only read from a header your proxy sets: Vercel's here, none elsewhere.
// Behind your own proxy, use { header: "x-forwarded-for", hops: 1 }.
export const { withApiKey, withRateLimit, withIdempotency, clientIp } = createRouteHelpers(gw, {
  trustProxy: process.env.VERCEL ? "vercel" : "none",
});

/** At most 20 new posts a minute per API key, on top of each key's own limit. */
export const postWrites = gw.rateLimit.rule({ name: "posts:write", limit: 20, window: "1m" });
