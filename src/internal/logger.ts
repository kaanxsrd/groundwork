/** Structured context attached to a log line. groundwork never puts secrets, raw keys or raw subjects in it. */
export type LogContext = Readonly<Record<string, unknown>>;

/** What groundwork logs through. `console` fits as is; wrap pino in {@link pinoLogger}. */
export interface Logger {
  debug?(message: string, context?: LogContext): void;
  info?(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/** The default: warnings and errors go to the console with a `[groundwork]` prefix; debug and info are dropped. */
export const consoleLogger: Logger = {
  warn: (message, context) =>
    context
      ? console.warn(`[groundwork] ${message}`, context)
      : console.warn(`[groundwork] ${message}`),
  error: (message, context) =>
    context
      ? console.error(`[groundwork] ${message}`, context)
      : console.error(`[groundwork] ${message}`),
};

/** A logger whose methods take the context first, as pino's and bunyan's do. */
export interface ContextFirstLogger {
  debug?(context: object, message: string): void;
  info?(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

/**
 * Adapts pino, or any logger that takes `(context, message)`, to groundwork's
 * `(message, context)`: `createGroundwork({ ..., logger: pinoLogger(logger) })`. Levels the
 * logger doesn't have are left out, and each call keeps the logger as `this`.
 */
export function pinoLogger(logger: ContextFirstLogger): Logger {
  const adapted: Logger = {
    warn: (message, context) => logger.warn(context ?? {}, message),
    error: (message, context) => logger.error(context ?? {}, message),
  };
  if (logger.debug) adapted.debug = (message, context) => logger.debug?.(context ?? {}, message);
  if (logger.info) adapted.info = (message, context) => logger.info?.(context ?? {}, message);
  return adapted;
}

/** A logger that drops everything. Handy in tests. */
export const silentLogger: Logger = {
  warn: () => {},
  error: () => {},
};

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Wraps a logger so each `key` is logged at most once, for messages that would otherwise repeat on
 * every request (such as "falling back to the in-memory rate limiter"). The memory of what was
 * logged belongs to this wrapper, not to the module, so there is no global state.
 */
export function createOnceLogger(logger: Logger): {
  once(level: LogLevel, key: string, message: string, context?: LogContext): boolean;
  reset(key?: string): void;
} {
  const seen = new Set<string>();
  return {
    once(level, key, message, context) {
      if (seen.has(key)) return false;
      seen.add(key);
      logger[level]?.(message, context);
      return true;
    },
    reset(key) {
      if (key === undefined) seen.clear();
      else seen.delete(key);
    },
  };
}
