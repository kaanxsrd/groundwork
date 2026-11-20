import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { gw } from "@/lib/groundwork";

/** Enqueued in the same transaction that creates a post, so it runs only if the post exists. */
export const announcePost = gw.jobs.define("post.announce", {
  schema: z.object({ postId: z.uuid() }),
  maxAttempts: 5,
  async run({ postId }) {
    // A real app would email followers or call a webhook here. A job can run more than once, so
    // the effect is idempotent: only a post that hasn't been announced yet is announced.
    const [post] = await db
      .update(posts)
      .set({ announcedAt: new Date() })
      .where(and(eq(posts.id, postId), isNull(posts.announcedAt)))
      .returning({ id: posts.id });
    if (post) {
      await gw.audit.record({
        actor: { type: "system" },
        action: "post.announce",
        entity: { type: "post", id: post.id },
      });
    }
  },
});

/** Once a day: drop audit entries older than a year and finished jobs older than two weeks. */
gw.jobs.schedule("retention", { every: "1d" }, async () => ({
  auditEntries: await gw.audit.prune({ olderThan: "365d" }),
  jobs: await gw.jobs.prune({ completedOlderThan: "14d" }),
}));
