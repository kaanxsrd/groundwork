/**
 * `@vantedev/groundwork/api-keys`: scoped API keys stored as HMAC hashes, with rotation, suspension, IP and
 * origin allowlists, and per-key rate limits and quotas.
 *
 * ```ts
 * import { createApiKeys } from "@vantedev/groundwork/api-keys";
 *
 * const apiKeys = createApiKeys({
 *   db, table: tables.apiKeys, secret, rateLimiter,
 *   namespace: "vnt",
 *   scopes: { "posts:read": "Read posts", "posts:write": "Create and edit posts" },
 * });
 *
 * const { key } = await apiKeys.create({ name: "CI deploy", scopes: ["posts:write"], expiresIn: "90d" });
 * const auth = await apiKeys.verify(request, { scopes: ["posts:write"], ip });
 * if (!auth.ok) return auth.response;
 * ```
 *
 * @module
 */
export { type ApiKeysOptions, createApiKeys } from "./api-keys.ts";
export { API_KEY_AUDIT_ACTIONS, type ApiKeyAuditAction, apiKeyAuditEvent } from "./audit.ts";
export type { GrantedScope, ScopeWildcard } from "./scopes.ts";
export type {
  ApiKeyEvent,
  ApiKeyEventType,
  ApiKeyFilter,
  ApiKeyPolicyInput,
  ApiKeyRateLimit,
  ApiKeyRecord,
  ApiKeyStatus,
  ApiKeys,
  CreateApiKeyInput,
  MutationOptions,
  UpdateApiKeyInput,
  VerifyFailureReason,
  VerifyOptions,
  VerifyResult,
} from "./types.ts";
