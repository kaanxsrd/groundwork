// drizzle-kit config for the test fixtures. groundwork itself never runs DDL: apps generate
// migrations from the table factories with their own drizzle-kit.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./tests/fixtures/schema.ts",
  out: "./tests/migrations",
});
