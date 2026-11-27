import { diff } from "../audit/diff.ts";
import type { AuditEvent } from "../audit/types.ts";
import type { ApiKeyEvent, ApiKeyRecord } from "./types.ts";

/** The audit actions groundwork records for API keys. `createGroundwork` accepts them for you. */
export const API_KEY_AUDIT_ACTIONS = [
  "api_key.create",
  "api_key.update",
  "api_key.rotate",
  "api_key.revoke",
  "api_key.suspend",
  "api_key.reinstate",
  "api_key.delete",
] as const;

export type ApiKeyAuditAction = (typeof API_KEY_AUDIT_ACTIONS)[number];

/** The fields worth diffing on update: the key's policy, not its bookkeeping. */
const policy = (key: ApiKeyRecord) => ({
  name: key.name,
  description: key.description,
  scopes: key.scopes,
  ownerId: key.ownerId,
  rateLimit: key.rateLimit,
  dailyQuota: key.dailyQuota,
  allowedIps: key.allowedIps,
  allowedOrigins: key.allowedOrigins,
  metadata: key.metadata,
  expiresAt: key.expiresAt,
});

/**
 * The audit entry for an API-key event. With `createGroundwork` this is recorded for you; on
 * its own, wire it up yourself:
 *
 * ```ts
 * createApiKeys({ …, onEvent: (event) => audit.record(apiKeyAuditEvent(event), { tx: event.tx }) });
 * ```
 *
 * Entries name the key and its prefix, never the key itself.
 */
export function apiKeyAuditEvent(event: ApiKeyEvent): AuditEvent<ApiKeyAuditAction, "api_key"> {
  const { key } = event;
  const label = `API key "${key.name}" (${key.prefix})`;
  const base = {
    actor: event.actor,
    action: `api_key.${event.type}` as ApiKeyAuditAction,
    entity: { type: "api_key" as const, id: key.id },
  };
  switch (event.type) {
    case "create":
      return { ...base, summary: `Created ${label}`, metadata: { scopes: [...key.scopes] } };
    case "update":
      return {
        ...base,
        summary: `Updated ${label}`,
        changes: diff(policy(event.before), policy(key)),
      };
    case "rotate":
      return {
        ...base,
        summary: `Rotated ${label}; the old key works until ${key.previousKeyExpiresAt?.toISOString() ?? "now"}`,
        metadata: { grace: event.grace },
      };
    case "revoke":
      return {
        ...base,
        summary: `Revoked ${label}${event.reason ? `: ${event.reason}` : ""}`,
        metadata: { reason: event.reason },
      };
    case "suspend":
      return {
        ...base,
        summary: `Suspended ${label} until ${key.suspendedUntil?.toISOString() ?? "?"}`,
        metadata: { reason: event.reason, until: key.suspendedUntil },
      };
    case "reinstate":
      return { ...base, summary: `Lifted the suspension on ${label}` };
    case "delete":
      return { ...base, summary: `Deleted revoked ${label}` };
  }
}
