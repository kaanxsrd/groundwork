---
"@vantedev/groundwork": minor
---

`ipSubject(ip)`, from `@vantedev/groundwork/rate-limit`, is the subject to rate-limit an IP address by. An IPv6 address counts as its `/64` network, so a client can't escape a limit by sending each request from another address in it; `{ ipv6Prefix: 56 }` widens that. IPv4 addresses count one by one, and IPv4-mapped IPv6 (`::ffff:203.0.113.7`) counts as the IPv4 address. `null` passes through, so `withRateLimit(rule, (request) => ipSubject(clientIp(request)), handler)` works as before when there's no trusted proxy. The docs now use it in every IP example. Switching a rule to it starts that rule's counts over.
