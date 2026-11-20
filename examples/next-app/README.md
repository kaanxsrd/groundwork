# groundwork example: Next.js 16

A small API that uses every groundwork module in one Next.js app:

| Module | Where |
| --- | --- |
| Table factories, migrated by the app's own drizzle-kit | [`db/schema/groundwork.ts`](db/schema/groundwork.ts), [`drizzle/`](drizzle) |
| Scoped API keys: created by an admin, verified on every request | [`app/api/admin/keys`](app/api/admin/keys/route.ts), [`app/api/posts`](app/api/posts/route.ts) |
| Rate limiting: each key's own limit, plus 20 writes a minute | [`lib/groundwork.ts`](lib/groundwork.ts) |
| Idempotency keys: `POST /api/posts` is safe to retry | [`app/api/posts`](app/api/posts/route.ts) |
| Audit log: written in the same transaction as the post | [`app/api/posts`](app/api/posts/route.ts), [`app/api/admin/audit`](app/api/admin/audit/route.ts) |
| Background jobs and a daily schedule, run by a cron route | [`lib/jobs.ts`](lib/jobs.ts), [`app/api/jobs`](app/api/jobs/route.ts) |
| Queue health | [`app/api/health`](app/api/health/route.ts) |

The config is what `create-next-app` 16.4 generates, Cache Components included. CI builds this app with `next build`, starts it, and drives every route over HTTP ([`scripts/example/example-checks.mjs`](../../scripts/example/example-checks.mjs)).

## Run it

With `@vantedev/groundwork` from npm: `npm install`, copy `.env.example` to `.env.local` and fill it in, then `npm run db:migrate` and `npm run dev`.

To run it against this checkout instead, from the repo root:

```sh
bun install
bun run db:up                       # Postgres in Docker
node scripts/example.mjs dev        # packs groundwork, installs this app in a temp folder, runs next dev
```

It packs the package, installs it into a copy of this app, and prints the secrets it generated.

## Try it

```sh
# An API key, as an admin. The key is in this response only.
curl -X POST http://localhost:3000/api/admin/keys -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" -d '{"name":"cli","scopes":["posts:read","posts:write"]}'

# A post. Send the same request again: you get the same post back, with Idempotent-Replayed: true.
curl -X POST http://localhost:3000/api/posts -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: post-0001-abcdef" -H "Content-Type: application/json" -d '{"title":"Hello"}'

# Run the queued job that announces it, then read the audit log.
curl http://localhost:3000/api/jobs -H "Authorization: Bearer $CRON_SECRET"
curl http://localhost:3000/api/admin/audit -H "Authorization: Bearer $ADMIN_SECRET"
```

## Notes

- **Admin routes** are guarded by a static `ADMIN_SECRET` to keep the example short. Use your app's real sign-in.
- **Client IPs** are read from Vercel's header on Vercel, and from no header elsewhere. See [`trustProxy`](../../docs/next.md#getclientiprequest--trustproxy-) before you rate-limit by IP.
- **Jobs** run when `/api/jobs` is called. [`vercel.json`](vercel.json) has Vercel Cron call it once a day, the most often Hobby plans allow (a more frequent schedule fails the deploy there). On Pro, use `*/5 * * * *` or `* * * * *`. Any other scheduler works too, and a long-running server can call `gw.jobs.work()` instead.
- **Migrations** in `drizzle/` are generated from `db/schema`. After changing it, run `npm run db:generate`.
