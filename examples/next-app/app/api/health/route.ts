import { connection } from "next/server";
import { gw } from "@/lib/groundwork";
import "@/lib/jobs";

/** Queue and schedule health, for uptime checks. */
export async function GET() {
  // Always answer at request time; never prerender this at build.
  await connection();
  const health = await gw.jobs.health();
  const ok = health.schedules.every((schedule) => schedule.healthy);
  return Response.json({ ok, ...health }, { headers: { "Cache-Control": "no-store" } });
}
