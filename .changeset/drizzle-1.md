---
"@vantedev/groundwork": minor
---

**groundwork now needs Drizzle 1.0 and Node.js 22.12 or newer.** The peer range is `drizzle-orm ^1.0.0`, and 0.4 is the last version for Drizzle 0.45. Node 22.12 is the oldest Node 22 that Drizzle 1.0 supports. Your groundwork calls don't change: they take a 1.0 database from any driver, as before. The tables are typed for Drizzle 1.0, so your own queries on them, such as `db.select().from(auditLog)`, need 1.0 too. A package built against one major can't type its tables for the other.

To upgrade, move `drizzle-orm` and `drizzle-kit` to 1.0 together with groundwork, run `npx drizzle-kit up` once to convert your migrations folder, and make the changes Drizzle 1.0 needs in your own code. `npx drizzle-kit generate` then finds no changes in groundwork's tables. [docs/schema.md](https://github.com/kaanxsrd/groundwork/blob/main/docs/schema.md#moving-to-drizzle-10) has the steps and the changes that are easy to miss: on postgres-js, raw SQL that binds JSON as `::jsonb` now stores it twice-encoded, and `drizzle-kit generate` stops if its `schema` reads a table twice.
