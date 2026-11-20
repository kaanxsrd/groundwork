import { desc } from "drizzle-orm";
import { diff } from "groundwork/audit";
import { z } from "zod";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { gw, postWrites, withApiKey, withIdempotency, withRateLimit } from "@/lib/groundwork";
import { announcePost } from "@/lib/jobs";

const NewPost = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000).default(""),
});

/** The latest posts. Needs an API key with `posts:read`. */
export const GET = withApiKey(["posts:read"], async () => {
  const latest = await db.select().from(posts).orderBy(desc(posts.createdAt)).limit(50);
  return Response.json({ posts: latest });
});

/**
 * Creates a post. Needs `posts:write`, counts against the key's write limit, and is safe to retry
 * with an `Idempotency-Key` header: a retry gets the first response back instead of a second post.
 */
export const POST = withApiKey(
  ["posts:write"],
  withRateLimit(
    postWrites,
    (_request, { apiKey }) => apiKey.id,
    withIdempotency(
      { scope: (_request, { apiKey }) => `apikey:${apiKey.id}` },
      async (request, { apiKey }) => {
        const input = NewPost.safeParse(await request.json().catch(() => null));
        if (!input.success) {
          return Response.json(
            { error: { code: "invalid_body", message: z.prettifyError(input.error) } },
            { status: 400 },
          );
        }
        const post = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(posts)
            .values({ ...input.data, authorKeyId: apiKey.id })
            .returning();
          if (!created) throw new Error("The insert returned no row.");
          // The audit entry and the job commit or roll back together with the post.
          await gw.audit.record(
            {
              actor: { type: "api_key", id: apiKey.id, label: apiKey.name },
              action: "post.create",
              entity: { type: "post", id: created.id },
              changes: diff(null, created),
            },
            { tx },
          );
          await announcePost.enqueue({ postId: created.id }, { tx });
          return created;
        });
        return Response.json(
          { post },
          { status: 201, headers: { Location: `/api/posts/${post.id}` } },
        );
      },
    ),
  ),
);
