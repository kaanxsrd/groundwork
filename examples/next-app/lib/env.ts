function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

/** The settings this app needs. A missing one fails at startup, not on the first request. */
export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  /** At least 32 bytes. Changing it invalidates every API key. */
  GROUNDWORK_SECRET: required("GROUNDWORK_SECRET"),
  CRON_SECRET: required("CRON_SECRET"),
  ADMIN_SECRET: required("ADMIN_SECRET"),
};
