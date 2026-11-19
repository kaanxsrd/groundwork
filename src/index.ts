/**
 * groundwork: Postgres-only, Drizzle-native building blocks for rate limiting, audit logs,
 * scoped API keys, background jobs and idempotency keys.
 *
 * `createGroundwork()` lands here as the modules are built. Today this entry point exports the
 * types and the error class that every module shares.
 *
 * @module
 */
export type { Clock } from "./internal/clock.ts";
export type { Secret } from "./internal/crypto.ts";
export type { Duration, DurationUnit } from "./internal/duration.ts";
export { GroundworkError, type GroundworkErrorCode, isGroundworkError } from "./internal/errors.ts";
export type { LogContext, Logger } from "./internal/logger.ts";
