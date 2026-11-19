CREATE TABLE "gw_harness_probe" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
