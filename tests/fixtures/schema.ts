// The Drizzle schema the integration tests run against. drizzle-kit generates tests/migrations
// from this file, exactly as an app's drizzle-kit would from its own schema.
import { groundworkTables } from "../../src/schema/index.ts";

// What most apps do: the default "gw_" prefix in the default schema.
export const { rateLimits, auditLog, apiKeys, jobs, jobSchedules } = groundworkTables();

// A second set with another prefix in its own Postgres schema, to prove both options end to end.
// The schema object is exported too, so drizzle-kit generates CREATE SCHEMA.
export const {
  schema: altSchema,
  rateLimits: altRateLimits,
  auditLog: altAuditLog,
  apiKeys: altApiKeys,
  jobs: altJobs,
  jobSchedules: altJobSchedules,
} = groundworkTables({
  prefix: "alt_",
  schema: "groundwork_alt",
});
