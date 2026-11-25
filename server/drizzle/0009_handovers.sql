CREATE TYPE "public"."handover_state" AS ENUM('requested', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired');--> statement-breakpoint
CREATE TABLE "alert_handlers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"actions" jsonb NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handover_progress" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "handover_progress_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"handover_id" bigint NOT NULL,
	"message" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "handovers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurrence_id" bigint NOT NULL,
	"handler_id" text NOT NULL,
	"handler_name" text NOT NULL,
	"handler_version" text NOT NULL,
	"action_id" text NOT NULL,
	"action_title" text NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"state" "handover_state" NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"claim_token" text,
	"snapshot" jsonb,
	"summary" text,
	"body" text,
	"links" jsonb,
	"error" text,
	CONSTRAINT "handovers_finished_matches_state" CHECK (("handovers"."state" in ('requested', 'running')) = ("handovers"."finished_at" is null)),
	CONSTRAINT "handovers_claimed_matches_state" CHECK ("handovers"."state" = 'cancelled' or ("handovers"."state" in ('requested', 'expired')) = ("handovers"."claimed_at" is null)),
	CONSTRAINT "handovers_running_has_lease" CHECK ("handovers"."state" <> 'running' or ("handovers"."lease_expires_at" is not null and "handovers"."deadline_at" is not null and "handovers"."claim_token" is not null))
);
--> statement-breakpoint
ALTER TABLE "handover_progress" ADD CONSTRAINT "handover_progress_handover_id_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handover_progress_handover_id" ON "handover_progress" USING btree ("handover_id","id");--> statement-breakpoint
CREATE INDEX "handovers_occurrence_id" ON "handovers" USING btree ("occurrence_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "handovers_one_active" ON "handovers" USING btree ("occurrence_id","handler_id","action_id") WHERE "handovers"."state" in ('requested', 'running');--> statement-breakpoint
CREATE INDEX "handovers_active" ON "handovers" USING btree ("state") WHERE "handovers"."state" in ('requested', 'running');