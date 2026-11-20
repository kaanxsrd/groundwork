import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  /** The API key that created the post. */
  authorKeyId: text("author_key_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set by the `post.announce` job. */
  announcedAt: timestamp("announced_at", { withTimezone: true }),
});
