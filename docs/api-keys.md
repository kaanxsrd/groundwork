# API keys

Scoped API keys for your own API. Only an HMAC of each key is stored. Keys can be rotated with a grace period, suspended, revoked and expired, limited to IP ranges and origins, and given their own rate limit and daily quota. Every change can be recorded in the audit log.

## Quickstart

1. Export the tables and generate a migration ([table factories](schema.md)). Per-key limits use the rate-limit table:

   ```ts
   export const { apiKeys, rateLimits, auditLog } = groundworkTables();
   ```

2. Declare your scopes:

   ```ts
   export const gw = createGroundwork({
     db,
     tables,
     secret: process.env.GROUNDWORK_SECRET!,
     audit: { actions: ["post.create"] }, // optional: records every key change
     apiKeys: {
       namespace: "vnt", // keys look like vnt_3f9ca0c44a15_…
       scopes: { "posts:read": "Read posts", "posts:write": "Create and edit posts" },
     },
   });
   ```

3. Create a key and show it once:

   ```ts
   const { key, record } = await gw.apiKeys.create(
     { name: "CI deploy", scopes: ["posts:write"], ownerId: user.id, expiresIn: "90d" },
     { actor: { type: "user", id: user.id, label: user.email } },
   );
   // `key` is never stored and can't be shown again. `record.prefix` (vnt_3f9ca0c44a15) can.
   ```

4. Check it on every request:

   ```ts
   export async function POST(request: Request) {
     const auth = await gw.apiKeys.verify(request, { scopes: ["posts:write"], ip: clientIp(request) });
     if (!auth.ok) return auth.response; // JSON 401, 403 or 429 with the right headers
     // auth.key.id, auth.key.ownerId, auth.key.scopes…
   }
   ```

## The key format

```
vnt_3f9ca0c44a15_dGhpcyBpcyBhbiBleGFtcGxlLCBub3QgYSByZWFsIGs4L39CM
└┬┘ └────┬─────┘ └───────────────────┬─────────────────────┘└─┬──┘
namespace prefix    secret: 32 random bytes, 43 base64url chars  checksum
```

- **namespace**: yours, 2–16 lower-case letters and digits. Pick something distinctive, so a leaked key is recognisable (and registrable with GitHub secret scanning).
- **prefix**: 12 random hex characters, stored in the clear, so people can tell keys apart. It changes on rotation.
- **checksum**: CRC32 of the rest, in 6 base62 characters. It isn't a secret: it catches every single-character typo before any database lookup, and lets scanners confirm a match. Set `checksum: false` to issue keys without one. Keys without a checksum always verify, which is how older keys (such as vante.app's) keep working.

`gw.apiKeys.redactKeys(text)` replaces any key in a log line or URL with `vnt_3f9ca0c44a15_[redacted]`.

## Scopes

Scopes are declared once, with descriptions (`gw.apiKeys.scopes`, for building a UI). TypeScript checks them everywhere:

- A key can be granted a declared scope, or a wildcard over one resource: `"posts:*"` covers `posts:read` and `posts:write`. The resource is the part before the first `:`.
- `verify(…, { scopes })` lists what the request needs. Every one must be granted, exactly or by its wildcard.

## Verifying

```ts
const auth = await gw.apiKeys.verify(requestOrHeadersOrKey, { scopes, ip, origin });
```

- **The key** is read from `Authorization: Bearer <key>`, else `X-API-Key`. You can also pass the raw string.
- **`ip`** is the client's address. It's required for keys with an IP allowlist; pass what your proxy setup says is the client.
- **`origin`** defaults to the request's `Origin` header.

Checks run in this order. The first failure wins:

| `reason` | Status | When |
| --- | --- | --- |
| `missing` | 401 | No key in the request. |
| `malformed` | 401 | Not a key of this namespace, or a bad checksum. **No database lookup.** |
| `invalid` | 401 | Well-formed, but unknown, or a rotated-out key past its grace period. |
| `revoked` | 401 | Revoked. |
| `expired` | 401 | Past `expiresAt`. |
| `suspended` | 403 | Suspended until `suspendedUntil`. |
| `ip_denied` | 403 | The key has `allowedIps` and `ip` isn't in them (or wasn't given). |
| `origin_denied` | 403 | The key has `allowedOrigins`, the request has an `Origin`, and it isn't allowed. |
| `forbidden_scope` | 403 | A required scope isn't granted. `missingScopes` lists them. |
| `rate_limited` | 429 | Over the key's rate limit. |
| `quota_exceeded` | 429 | Over the key's daily quota. |

On failure the result has `reason`, `status`, `message`, `headers`, the `key` when one was found, `prefix` (the presented key's `vnt_3f9ca0c44a15`, when it parsed: log it for failed attempts, never the key), and a ready `response`:

```json
{ "error": { "code": "forbidden_scope", "message": "This API key does not have the scopes this request needs.", "missingScopes": ["posts:write"] } }
```

401s carry `WWW-Authenticate: Bearer error="invalid_token"` (or just `Bearer` when no key was sent). A scope failure carries `Bearer error="insufficient_scope", scope="…"`, as RFC 6750 describes. 429s carry `Retry-After` and the `RateLimit` headers. On success, `auth.headers` holds the key's `RateLimit` headers for your response.

**Allowlists:**

- `allowedIps` takes IPv4 and IPv6 addresses and CIDR blocks (`203.0.113.0/24`, `2001:db8::/32`). An IPv4 rule also matches the IPv4-mapped form (`::ffff:203.0.113.7`) some servers report. A block with host bits set (`10.0.0.1/8`) is rejected as a likely typo.
- `allowedOrigins` takes full origins (`https://app.example.com`), compared case-insensitively with default ports dropped. A request without an `Origin` header isn't held to the list: only browsers send one, and anything else can set it to whatever it likes. Origin limits protect browser keys from use on other sites, not from someone who already has the key.

**Round trips:** finding the key is one query, covering both the current key and a rotated-out key in its grace period. A per-key rate limit adds one check, and a daily quota one more. They run only after every other check has passed.

## Lifecycle

| Method | Effect |
| --- | --- |
| `create(input, { actor, tx })` | New key. Returns `{ key, record }`; `key` is never shown again. |
| `get(id)`, `list({ ownerId, status, limit })` | Records, never hashes. `status` is `active`, `suspended`, `expired` or `revoked`. |
| `update(id, patch, …)` | Name, description, scopes, owner, limits, allowlists, metadata, `expiresAt`. |
| `rotate(id, { grace: "24h" })` | New key and prefix. The old key keeps working until the grace period ends (`"0s"`: at once). Rotating again during a grace period ends the older key's grace. |
| `suspend(id, { for: "1h", reason })` | Blocks the key until then. `reinstate(id)` lifts it early. |
| `revoke(id, { reason })` | Permanent, for the key and any rotated-out key. |
| `delete(id)` | Deletes a revoked key's record. Active keys must be revoked first. |

Every method takes `{ actor, tx }`. With `tx` the change, and its audit entry, commits or rolls back with your transaction.

## Rate limits and quotas

- **Rate limit:** each key gets its own limit through the [rate limiter](rate-limiting.md) (`gw.rateLimit`). It defaults to 60 a minute. Set `rateLimit: { limit, window }` per key, `null` for none, or change the default with `apiKeys.defaultRateLimit` (`null` turns it off, and then no rate-limit table is needed).
- **Daily quota:** `dailyQuota` caps requests per day, counted in a day-long window that starts at the key's first request (as vante.app counts it today).

The counters' rows are named `<namespace>:key` and `<namespace>:key.daily`, and the subject is the key's id. Changing a key's limit keeps its counter.

## Last use

`lastUsedAt` and `lastUsedIp` are updated at most once a minute per key, outside the request's critical path, and only after a successful check. On serverless platforms, pass the platform's way to keep background work alive as `waitUntil` (for example Next.js `after`, or `ctx.waitUntil`). Otherwise the write may be cut off when the response is sent.

## Audit log

With both modules wired through `createGroundwork`, every change is recorded as `api_key.create`, `api_key.update`, `api_key.rotate`, `api_key.suspend`, `api_key.reinstate`, `api_key.revoke` or `api_key.delete`. Each entry has entity `{ type: "api_key", id }`, the actor you pass, a summary naming the key and its prefix, and the changed fields for updates. Keys are never written. `gw.audit` accepts these actions without you listing them.

On their own:

```ts
import { apiKeyAuditEvent, createApiKeys } from "groundwork/api-keys";

createApiKeys({ …, onEvent: (event) => audit.record(apiKeyAuditEvent(event), { tx: event.tx }) });
```

## Security notes

- Keys are stored as HMAC-SHA256 under a subkey derived from your app secret (see [the app secret](core-concepts.md#the-app-secret)). A database leak alone doesn't reveal or verify keys. **Changing the secret invalidates every key.**
- The hash comparison is timing-safe. Lookup is by hash through a unique index.
- Keys never appear in logs, errors, audit entries or records.
- A malformed or mistyped key is rejected before any database work.

## Moving from vante.app

vante.app's keys use the same format without a checksum, stored as `HMAC(pepper, key)`. Copy the rows over, then verify with the old pepper until every key has been used once:

```sql
insert into gw_api_keys (id, name, description, prefix, key_hash, previous_key_hash, previous_key_expires_at,
  scopes, rate_limit, rate_limit_window, daily_quota, allowed_origins, allowed_ips, metadata,
  expires_at, revoked_at, revoked_reason, suspended_until, suspended_reason, rotated_at,
  last_used_at, last_used_ip, created_by, created_at, updated_at)
select id, name, description, prefix, key_hash, previous_key_hash, previous_key_expires_at,
  scopes, rate_limit_per_minute, '1m', daily_quota, allowed_origins, allowed_ips,
  jsonb_build_object('expectedCountries', expected_countries),
  expires_at, revoked_at, revoked_reason, suspended_until, suspended_reason, rotated_at,
  last_used_at, last_used_ip, created_by, created_at, updated_at
from api_keys;
```

```ts
import { createHmac } from "node:crypto";

createGroundwork({
  …,
  apiKeys: {
    namespace: "vnt",
    scopes: API_SCOPES,
    legacyHash: (key) => createHmac("sha256", process.env.API_KEY_PEPPER!).update(key).digest("hex"),
  },
});
```

A key that verifies through `legacyHash` is moved to groundwork's hash in the background. Once every active key has been used, `legacyHash` and the old pepper can go. vante.app's exact-match `allowed_ips` values are valid single-address CIDR entries. Country checks are out of scope; the SQL above keeps them in `metadata`.
