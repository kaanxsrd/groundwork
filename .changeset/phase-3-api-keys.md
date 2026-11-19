---
"groundwork": minor
---

Scoped API keys.

- `groundworkTables()` now also returns `apiKeys` (`gw_api_keys`). Only an HMAC of each key is stored, under a unique index. The table also keeps a partial index on the previous hash, used during rotation grace periods.
- `groundwork/api-keys`: `createApiKeys({ db, table, secret, namespace, scopes, rateLimiter })`, or `gw.apiKeys` from `createGroundwork({ apiKeys })`.
  - Keys look like `<namespace>_<12 hex>_<43 base64url>` with a CRC32 checksum suffix. Typos and foreign keys are rejected without a database lookup, and keys without a checksum still verify.
  - Scopes are typed from the config and can be granted as `resource:*` wildcards.
  - `verify(request | headers | key, { scopes, ip, origin })` finds the key, current or within its rotation grace period, in one query.
    - It returns `{ ok: true, key, headers }`, or `{ ok: false, reason, status, response }`. Reasons: `missing`, `malformed`, `invalid`, `revoked`, `expired`, `suspended`, `ip_denied`, `origin_denied`, `forbidden_scope`, `rate_limited`, `quota_exceeded`.
    - The JSON response carries RFC 6750 `WWW-Authenticate` headers.
  - IPv4 and IPv6 CIDR allowlists, which also match IPv4-mapped addresses, and origin allowlists.
  - Per-key rate limit (default 60/min) and daily quota through the rate limiter.
  - Lifecycle: `create`, `update`, `rotate({ grace })`, `suspend({ for })`, `reinstate`, `revoke`, `delete`, `get`, `list`. Every method takes `{ actor, tx }`.
  - `lastUsedAt` and `lastUsedIp` are written at most once a minute, in the background (`waitUntil` hook).
  - `legacyHash` keeps keys from an older system working, and upgrades each one on first use.
  - `redactKeys(text)`.
- With the audit log wired, every key change is recorded as `api_key.*`, which `gw.audit` accepts automatically. `apiKeyAuditEvent()` maps events for standalone use.
