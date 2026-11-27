import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't read .env.local the way Next.js does.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No file: the variables come from the environment.
}

export default defineConfig({
  dialect: "postgresql",
  // The index, not the folder: index.ts re-exports the other files, and drizzle-kit 1.0 would
  // read each of their tables twice.
  schema: "./db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
