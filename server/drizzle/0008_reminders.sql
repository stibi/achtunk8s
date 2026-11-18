ALTER TYPE "public"."event_kind" ADD VALUE 'reminder_set';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'reminder_cancelled';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'reminded';--> statement-breakpoint
CREATE TABLE "reminders" (
	"occurrence_id" bigint PRIMARY KEY NOT NULL,
	"remind_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_remind_at" ON "reminders" USING btree ("remind_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_remind_at_matches_kind" CHECK (("events"."kind"::text = 'reminder_set') = ("events"."remind_at" is not null));