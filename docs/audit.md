# Audit log

An append-only record of who did what, stored in your Postgres. Entries are written inside your transaction, actions are typed, sensitive keys are redacted before they reach the database, and pages are read with keyset pagination.

## Quickstart

1. Export the table and generate a migration ([table factories](schema.md)):

   ```ts
   // src/db/schema/groundwork.ts
   import { groundworkTables } from "@vantedev/groundwork/schema";
   export const { auditLog } = groundworkTables();
   ```

2. Declare your actions once:

   ```ts
   import { createGroundwork } from "@vantedev/groundwork";
   import * as tables from "@/db/schema/groundwork";

   export const gw = createGroundwork({
     db,
     tables,
     secret: process.env.GROUNDWORK_SECRET!,
     audit: {
       actions: ["post.create", "post.update", "post.delete", "api_key.revoke"],
       entityTypes: ["post", "api_key"], // optional: types entity.type too
       redact: ["iban"], // added to the defaults
     },
   });
   ```

   Using only the audit log? `createAuditLog({ db, table: auditLog, actions })` from `@vantedev/groundwork/audit` does the same.

3. Record inside the transaction that makes the change:

   ```ts
   import { diff } from "@vantedev/groundwork/audit";

   await db.transaction(async (tx) => {
     const [before] = await tx.select().from(posts).where(eq(posts.id, id));
     const [after] = await tx.update(posts).set(input).where(eq(posts.id, id)).returning();
     await gw.audit.record(
       {
         actor: { type: "user", id: user.id, label: user.email },
         action: "post.update",
         entity: { type: "post", id },
         summary: `Updated post "${after.title}"`,
         changes: diff(before, after, { ignore: ["updatedAt"] }),
       },
       { tx },
     );
   });
   ```

   If the transaction rolls back, the entry goes with it. If it commits, the entry carries the transaction's timestamp, the same `now()` as the change itself.

## Events

| Field | Required | Meaning |
| --- | --- | --- |
| `actor` | yes | `{ type, id?, label? }`. `type` is usually `"user"`, `"api_key"` or `"system"`, but any string works. `label` is stored as is (an email, say), so the log stays readable after the user is deleted. |
| `action` | yes | One of the declared `actions`. TypeScript rejects anything else, and so does the runtime check. |
| `entity` | no | `{ type, id? }`: what was acted on. With `entityTypes` configured, `type` is checked too. |
| `summary` | no | A sentence for people. **Not redacted**, so never put secrets in it. |
| `changes` | no | What changed, usually `diff(before, after)`. JSON. |
| `metadata` | no | Anything else: a user agent, a reason, a ticket number. JSON. |
| `ip`, `requestId` | no | Stored as given. |
| `occurredAt` | no | Defaults to the transaction's time (or the injected `clock`). Set it when importing old entries. |

`record()` returns the entry as stored, with its `id` and `occurredAt`. `recordMany()` writes up to 1,000 entries in one statement, all or none.

Ids are numbers. Ids given as numbers (`entity.id`, `actor.id`) are stored and returned as strings, so you can filter on them however your app writes them.

### When recording fails

`record()` throws: on an invalid event (`GroundworkError` with code `invalid_argument`, before anything is sent) and on a database error.

Both apps this was extracted from swallowed audit errors. Inside a transaction that doesn't work: Postgres aborts the whole transaction on the first error, so the change you meant to keep fails anyway, later, with a confusing message. If you want best-effort logging outside a transaction, catch the error yourself:

```ts
await gw.audit.record(event).catch((error) => logger.error("audit write failed", { error }));
```

## diff

```ts
diff(before, after, { ignore: ["updatedAt"] });
// { title: ["Old", "New"], tags: [["a"], ["a", "b"]] }
```

- Returns only changed fields, as `[before, after]`.
- Nested values (objects, arrays, Dates, Maps, Sets, Buffers) are compared deeply and reported whole.
- A missing side is `null`, so pass `null` as `before` for a create, or as `after` for a delete.
- It's typed from the row: `ignore` only accepts the row's keys.

## Redaction

Matching keys in `changes` and `metadata` are replaced with `"[redacted]"` (exported as `REDACTED`, for tests and display code) at any depth, including inside arrays and inside `diff()` tuples, before the entry is sent to the database.

- **Defaults:** `password`, `passwd`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `privateKey` (exported as `DEFAULT_REDACT`).
- **Matching:** a string rule matches any key that *contains* it, ignoring case, `_` and `-`. So `token` covers `accessToken`, `refresh_token` and `X-Session-Token`. A `RegExp` rule is tested against the raw key: `/^ssn$/i`.
- **Your rules** (`redact`) are added to the defaults. Pass `redactDefaults: false` to use only yours. Over-matching (`tokenCount` is redacted by default) is the safer failure.
- **Not redacted:** `summary`, `actor.label`, `ip`, `requestId` and `entity.id`. Keep secrets out of them.

Values are also normalised for JSON: Dates become ISO strings, bigints become strings, `undefined` and functions are dropped, Maps and Sets become objects and arrays, and cycles are cut. Your objects are never modified.

## Reading

```ts
const { entries, nextCursor } = await gw.audit.query({
  action: ["post.update", "post.delete"],
  entity: { type: "post", id: postId },
  from: new Date("2026-01-01"),
  limit: 50,
});
const next = await gw.audit.query({ action: ["post.update", "post.delete"], entity: { type: "post", id: postId }, cursor: nextCursor });
const total = await gw.audit.count({ entity: { type: "post", id: postId } });
```

| Filter | Matches |
| --- | --- |
| `action` | one action or a list |
| `actorType`, `actorId` | e.g. `actorType: "system"` for entries with no user |
| `entity` | `{ type?, id? }`; each can be one value or a list |
| `requestId` | an exact request id |
| `from`, `to` | `from` is inclusive, `to` is exclusive |
| `search` | case-insensitive text in the summary, entity id and actor label; `%` and `_` match literally |
| `where` | any Drizzle condition on the table's columns (below) |

Results are newest first. Pass `order: "asc"` for oldest first, such as a timeline or an export. `limit` is 1 to 1,000 (default 50). Pass `nextCursor` back as `cursor` with the same filters and order to get the next page; it's `null` on the last page.

### Custom conditions

`where` takes any condition, written with the table's own columns. bubblehouse-dk's order timeline, which shows order events plus payment and shipment events that name the order in their changes:

```ts
import { eq, or, sql } from "drizzle-orm";

await gw.audit.query({
  entity: { type: ["order", "payment", "shipment"] },
  where: or(eq(auditLog.entityId, order.id), sql`${auditLog.changes}->>'orderNumber' = ${order.number}`),
  limit: 30,
});
```

For anything else, such as joining your users table to show names, query the table directly. It's an ordinary Drizzle table:

```ts
db.select({ action: auditLog.action, at: auditLog.occurredAt, name: users.name })
  .from(auditLog)
  .leftJoin(users, eq(users.id, auditLog.actorId))
  .orderBy(desc(auditLog.occurredAt), desc(auditLog.id));
```

### What pagination guarantees

Cursor pages are keyset pages on `(occurred_at, id)`. While you page through with a cursor:

- **no entry appears twice**, even while others are being written;
- **every entry that was committed before you started appears exactly once**;
- entries committed while you page may or may not appear. Newer entries sort above your cursor in a newest-first walk. An entry from a long transaction that commits after you've paged past its timestamp is not shown in that walk. Every timestamp-ordered log behaves this way.

The integration tests check all three under concurrent writers, including 100 entries that share one timestamp.

### Page numbers

An admin page with numbered pages ("page 7 of 30") can pass `offset` instead of `cursor`, with `count()` for the total:

```ts
const pageSize = 50;
const [page, total] = await Promise.all([
  gw.audit.query({ ...filters, limit: pageSize, offset: (pageNumber - 1) * pageSize }),
  gw.audit.count(filters),
]);
```

Offsets don't have the guarantees above: while the log grows, an entry can show on two pages or on none. `offset` goes up to 100,000; page further with cursors. It can't be combined with `cursor`.

## Retention

```ts
const deleted = await gw.audit.prune({ olderThan: "365d" });
```

This is the only way groundwork ever removes entries. It deletes in batches of 5,000. Run it from a scheduled job; once the jobs module lands, it can do the scheduling.

## Making the table tamper-resistant

groundwork never updates entries and only deletes them in `prune()`. To make sure nothing else can either, run your app as a role that may only insert and read:

```sql
-- As the role that owns the table (the one that runs your migrations):
revoke update, delete, truncate on gw_audit_log from app_user;
grant select, insert on gw_audit_log to app_user;
grant usage on sequence gw_audit_log_id_seq to app_user;
```

Then run `prune()` from a maintenance role that has `delete`. This only helps if the app doesn't connect as the table's owner: an owner can always grant itself rights back. If you need more than that, also ship entries to storage the database can't rewrite.

## Moving from a hand-rolled table

Old entries can be copied over with SQL. `id` is generated, so leave it out, and insert in time order. For vante.app's `audit_logs`:

```sql
insert into gw_audit_log (occurred_at, actor_type, actor_label, action, entity_type, entity_id, summary, metadata, ip)
select created_at, 'user', actor, action, entity_type, entity_id, summary, metadata, ip
from audit_logs order by created_at, id;
```

And bubblehouse-dk's `audit_log` (a null actor was the system):

```sql
insert into gw_audit_log (occurred_at, actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, changes)
select created_at, case when actor_id is null then 'system' else 'user' end, actor_id, actor_role,
       action, entity_type, entity_id, description, changes
from audit_log order by created_at, id;
```

Add every old action name to `actions`, or queries for them won't type-check. A SQL copy skips redaction, so old rows arrive exactly as they were stored: check them for secrets first.
