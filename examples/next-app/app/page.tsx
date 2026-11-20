const ROUTES = [
  ["POST /api/admin/keys", "Create an API key (admin)."],
  ["GET /api/admin/audit", "Read the audit log (admin)."],
  ["GET /api/posts", "List posts: needs a key with posts:read."],
  ["POST /api/posts", "Create a post: posts:write, rate limited, retry-safe with Idempotency-Key."],
  ["GET /api/jobs", "Run due jobs and schedules: needs CRON_SECRET."],
  ["GET /api/health", "Queue and schedule health."],
] as const;

export default function Home() {
  return (
    <main>
      <h1>groundwork example</h1>
      <p>
        Rate limiting, audit logs, scoped API keys, background jobs and idempotency keys, all in
        this app&apos;s own Postgres. See README.md for a walkthrough with curl.
      </p>
      <ul>
        {ROUTES.map(([route, what]) => (
          <li key={route}>
            <code>{route}</code>: {what}
          </li>
        ))}
      </ul>
    </main>
  );
}
