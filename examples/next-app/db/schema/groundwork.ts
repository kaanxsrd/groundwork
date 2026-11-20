import { groundworkTables } from "@vante/groundwork/schema";

// groundwork's tables live in your schema, so your drizzle-kit migrates them with everything else.
export const { rateLimits, auditLog, apiKeys, jobs, jobSchedules, idempotencyKeys } =
  groundworkTables();
