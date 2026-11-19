# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting (the repository's **Security** tab → **Report a vulnerability**), not in a public issue. Include the affected version or commit, what you found, how to reproduce it and what you think the impact is. Never include real API keys or secrets from a live system.

You will get an answer within three days. Once a fix is ready we publish it, credit you if you want, and describe the issue in the changelog.

## Scope

In scope: everything in the published package (`src/`), including the table definitions it generates and the SQL it runs.

Out of scope: denial of service through sheer volume against an app that uses groundwork, and problems that need an already compromised database or app server.

## Security properties we treat as critical

- A raw API key, a raw rate-limit subject (such as an IP address) or the app secret reaching the database, a log line, an error message or a response.
- A configured redacted field reaching the audit log.
- A comparison involving a secret, key hash or signature that is not timing-safe.
- An API key that verifies after it was revoked, expired, suspended or rotated past its grace period, or that verifies with a scope, IP or origin it isn't allowed.
- A rate limit or quota that can be exceeded under concurrency.
- A job that runs more than once per attempt, or runs after its transaction rolled back.
- An idempotent request whose handler runs twice, or whose stored response is replayed for a different request body.

## Supported versions

Before 1.0, security fixes go into the latest release only.
