CREATE TABLE "gw_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"previous_key_hash" text,
	"previous_key_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"owner_id" text,
	"rate_limit" integer,
	"rate_limit_window" text,
	"daily_quota" integer,
	"allowed_ips" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"suspended_until" timestamp with time zone,
	"suspended_reason" text,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gw_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"summary" text,
	"changes" jsonb,
	"metadata" jsonb,
	"ip" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "gw_idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"fingerprint" text NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"response" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_job_schedules" (
	"name" text PRIMARY KEY NOT NULL,
	"every" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"claims" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"dedupe_key" text,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_jobs_status_check" CHECK (status in ('pending', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "gw_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"rule" text NOT NULL,
	"used" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gw_api_keys_key_hash_idx" ON "gw_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "gw_api_keys_prefix_idx" ON "gw_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "gw_api_keys_previous_key_hash_idx" ON "gw_api_keys" USING btree ("previous_key_hash") WHERE previous_key_hash is not null;--> statement-breakpoint
CREATE INDEX "gw_api_keys_owner_idx" ON "gw_api_keys" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "gw_audit_log_occurred_at_idx" ON "gw_audit_log" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "gw_audit_log_action_idx" ON "gw_audit_log" USING btree ("action","occurred_at","id");--> statement-breakpoint
CREATE INDEX "gw_audit_log_entity_idx" ON "gw_audit_log" USING btree ("entity_type","entity_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "gw_audit_log_actor_idx" ON "gw_audit_log" USING btree ("actor_type","actor_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "gw_idempotency_keys_expires_at_idx" ON "gw_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "gw_jobs_claim_idx" ON "gw_jobs" USING btree ("priority" DESC NULLS LAST,"run_at","id") WHERE status in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "gw_jobs_dedupe_idx" ON "gw_jobs" USING btree ("type","dedupe_key") WHERE dedupe_key is not null and status in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "gw_jobs_finished_idx" ON "gw_jobs" USING btree ("completed_at") WHERE status in ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "gw_rate_limits_expires_at_idx" ON "gw_rate_limits" USING btree ("expires_at");