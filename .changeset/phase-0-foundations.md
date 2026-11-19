---
"groundwork": minor
---

Package skeleton: ESM-only subpath exports (`groundwork`, `/schema`, `/rate-limit`, `/audit`, `/api-keys`, `/jobs`, `/idempotency`, `/next`, `/testing`), with `drizzle-orm` as the only peer dependency. The root entry exports `GroundworkError`, `isGroundworkError` and the shared `Duration`, `Logger`, `Clock` and `Secret` types. The module entry points are empty until their phases land.
