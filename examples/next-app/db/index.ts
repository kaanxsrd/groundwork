import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";

// One pool per server process. `next dev` re-runs modules on every change, so the pool is kept
// on globalThis there instead of opening a new one each time.
const globalForDb = globalThis as typeof globalThis & {
  postgresClient?: ReturnType<typeof postgres>;
};
const client = globalForDb.postgresClient ?? postgres(env.DATABASE_URL, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.postgresClient = client;

export const db = drizzle({ client });
