import type { SQL } from "drizzle-orm";
import type { GroundworkDatabase } from "../internal/db.ts";
import type { Duration } from "../internal/duration.ts";

/** Who did it. `type` is usually `"user"`, `"api_key"` or `"system"`, but any string works. */
export interface AuditActor {
  readonly type: "user" | "api_key" | "system" | (string & {});
  /** The actor's id in your app. Leave it out for `"system"`. */
  readonly id?: string | number | null | undefined;
  /** A readable name stored with the entry, such as an email, so the log stays readable after the user is deleted. */
  readonly label?: string | null | undefined;
}

/** What it was done to. */
export interface AuditEntityRef<TEntity extends string = string> {
  readonly type: TEntity;
  readonly id?: string | number | null | undefined;
}

/** A JSON object stored with an entry. Configured keys are redacted at any depth. */
export type AuditData = Readonly<Record<string, unknown>>;

export interface AuditEvent<TAction extends string = string, TEntity extends string = string> {
  readonly actor: AuditActor;
  /** One of the actions declared in `actions`. */
  readonly action: TAction;
  readonly entity?: AuditEntityRef<TEntity> | null | undefined;
  /** A sentence for people, such as `Updated post "Hello"`. Never put secrets here: it isn't redacted. */
  readonly summary?: string | null | undefined;
  /** What changed, usually `diff(before, after)`. */
  readonly changes?: AuditData | null | undefined;
  /** Anything else worth keeping, such as a user agent or a reason. */
  readonly metadata?: AuditData | null | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  /** When it happened. Defaults to the transaction's time (or the injected clock). Use it to import old entries. */
  readonly occurredAt?: Date | undefined;
}

/** An entry as stored, after redaction. */
export interface AuditEntry<TAction extends string = string, TEntity extends string = string> {
  readonly id: number;
  readonly occurredAt: Date;
  readonly actor: {
    readonly type: string;
    readonly id: string | null;
    readonly label: string | null;
  };
  readonly action: TAction;
  readonly entity: { readonly type: TEntity; readonly id: string | null } | null;
  readonly summary: string | null;
  readonly changes: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
  readonly ip: string | null;
  readonly requestId: string | null;
}

export interface RecordOptions {
  /** Record inside this transaction, so the entry commits or rolls back with your change. */
  readonly tx?: GroundworkDatabase | undefined;
}

type OneOrMany<T> = T | readonly T[];

/** Filters for `query()` and `count()`. All of them are optional and combine with AND. */
export interface AuditFilters<TAction extends string = string, TEntity extends string = string> {
  readonly action?: OneOrMany<TAction> | undefined;
  readonly actorType?: OneOrMany<string> | undefined;
  readonly actorId?: string | number | undefined;
  readonly entity?:
    | {
        readonly type?: OneOrMany<TEntity> | undefined;
        readonly id?: OneOrMany<string | number> | undefined;
      }
    | undefined;
  readonly requestId?: string | undefined;
  /** Entries at or after this time. */
  readonly from?: Date | undefined;
  /** Entries before this time. */
  readonly to?: Date | undefined;
  /** Case-insensitive text search in the summary, the entity id and the actor label. */
  readonly search?: string | undefined;
  /**
   * Any extra condition, written with the table's own columns:
   * `` sql`${auditLog.changes}->>'orderNumber' = ${orderNumber}` ``.
   */
  readonly where?: SQL | undefined;
}

export interface AuditQuery<TAction extends string = string, TEntity extends string = string>
  extends AuditFilters<TAction, TEntity> {
  /** Newest first (`"desc"`, the default) or oldest first (`"asc"`). */
  readonly order?: "desc" | "asc" | undefined;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: string | null | undefined;
  /** Entries per page, 1 to 1,000. Defaults to 50. */
  readonly limit?: number | undefined;
}

export interface AuditPage<TAction extends string = string, TEntity extends string = string> {
  readonly entries: AuditEntry<TAction, TEntity>[];
  /** Pass it as `cursor` to get the next page. `null` on the last page. */
  readonly nextCursor: string | null;
}

export interface AuditLog<TAction extends string = string, TEntity extends string = string> {
  /** The declared actions. */
  readonly actions: readonly TAction[];
  /** Records one entry and returns it as stored. */
  record(
    event: AuditEvent<TAction, TEntity>,
    options?: RecordOptions,
  ): Promise<AuditEntry<TAction, TEntity>>;
  /** Records up to 1,000 entries in one statement, all or none. Returns them in order. */
  recordMany(
    events: readonly AuditEvent<TAction, TEntity>[],
    options?: RecordOptions,
  ): Promise<AuditEntry<TAction, TEntity>[]>;
  /** One page of entries, with keyset pagination: no duplicates or skipped rows between pages. */
  query(query?: AuditQuery<TAction, TEntity>): Promise<AuditPage<TAction, TEntity>>;
  /** How many entries match, for "1,204 entries" in a UI. */
  count(filters?: AuditFilters<TAction, TEntity>): Promise<number>;
  /** Deletes entries older than `olderThan`. The only way groundwork ever removes entries. */
  prune(options: { readonly olderThan: Duration }): Promise<number>;
}
