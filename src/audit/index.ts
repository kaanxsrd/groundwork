/**
 * `@vantedev/groundwork/audit`: an append-only audit log in your Postgres, with typed actions, diffs,
 * redaction and keyset pagination.
 *
 * ```ts
 * import { createAuditLog, diff } from "@vantedev/groundwork/audit";
 *
 * const audit = createAuditLog({ db, table: auditLog, actions: ["post.create", "post.update"] });
 *
 * await db.transaction(async (tx) => {
 *   const [after] = await tx.update(posts).set(input).where(eq(posts.id, id)).returning();
 *   await audit.record(
 *     { actor: { type: "user", id: user.id }, action: "post.update", entity: { type: "post", id }, changes: diff(before, after) },
 *     { tx },
 *   );
 * });
 * ```
 *
 * @module
 */
export { type AuditLogOptions, createAuditLog } from "./audit-log.ts";
export { type AuditDiff, type DiffOptions, diff } from "./diff.ts";
export { DEFAULT_REDACT, REDACTED, type RedactRule } from "./json.ts";
export type {
  AuditActor,
  AuditData,
  AuditEntityRef,
  AuditEntry,
  AuditEvent,
  AuditFilters,
  AuditLog,
  AuditPage,
  AuditQuery,
  RecordOptions,
} from "./types.ts";
