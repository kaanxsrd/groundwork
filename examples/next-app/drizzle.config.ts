import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't read .env.local the way Next.js does.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No file: the variables come from the environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
