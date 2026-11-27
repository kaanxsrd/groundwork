import { jobsRoute } from "@vantedev/groundwork/next";
import { env } from "@/lib/env";
import { gw } from "@/lib/groundwork";
// Defines the jobs and schedules: a worker only runs the job types it knows.
import "@/lib/jobs";

export const maxDuration = 60;

/**
 * Runs due jobs and schedules for up to 50 seconds. Vercel Cron calls it (see vercel.json); any
 * other scheduler can too: `curl -H "Authorization: Bearer $CRON_SECRET" …/api/jobs`.
 */
export const GET = jobsRoute(gw, { secret: env.CRON_SECRET, budget: "50s" });
export const POST = GET;
