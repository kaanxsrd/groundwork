CREATE SCHEMA "groundwork_alt";
--> statement-breakpoint
CREATE TABLE "groundwork_alt"."alt_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"rule" text NOT NULL,
	"used" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
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
CREATE INDEX "alt_rate_limits_expires_at_idx" ON "groundwork_alt"."alt_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "gw_rate_limits_expires_at_idx" ON "gw_rate_limits" USING btree ("expires_at");