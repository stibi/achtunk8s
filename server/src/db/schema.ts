import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AlertLink } from "../domain/alert.ts";

// Change this file, then run `pnpm run db:generate` and commit the generated migration.
// Column names are snake_case in the database (see `casing` in client.ts).

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

export const channels = pgTable(
  "channels",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // Rows from before instances existed get the default instance (ADR 0006).
    instance: text().notNull().default("default"),
    slug: text().notNull(),
    // What last delivered to the channel, e.g. Alertmanager's receiver (ADR 0010); null
    // until a notification names one.
    receiver: text(),
    createdAt: timestamptz().notNull(),
  },
  (table) => [unique("channels_instance_slug").on(table.instance, table.slug)],
);

export const occurrenceStatus = pgEnum("occurrence_status", ["firing", "resolved"]);
export const severity = pgEnum("severity", ["critical", "warning", "info", "unknown"]);
export const eventKind = pgEnum("event_kind", [
  "fired",
  "resolved",
  "reopened",
  "resent",
  "reminder_set",
  "reminder_cancelled",
  "reminded",
]);
// Why Achtung recorded an event itself, rather than because a notification said so.
export const eventCause = pgEnum("event_cause", ["vanished"]);

/** One occurrence of an alert: its identity plus startsAt (docs/architecture.md). */
export const occurrences = pgTable(
  "occurrences",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer()
      .notNull()
      .references(() => channels.id),
    source: text().notNull(),
    sourceKey: text().notNull(),
    startsAt: timestamptz().notNull(),
    status: occurrenceStatus().notNull(),
    endsAt: timestamptz(),
    severity: severity().notNull(),
    title: text().notNull(),
    summary: text(),
    labels: jsonb().$type<Record<string, string>>().notNull(),
    annotations: jsonb().$type<Record<string, string>>().notNull(),
    links: jsonb().$type<readonly AlertLink[]>().notNull(),
    firstReceivedAt: timestamptz().notNull(),
    lastReceivedAt: timestamptz().notNull(),
    // The default only serves replicas from before this column during a rolling deploy;
    // current code always sets it.
    lastEventAt: timestamptz().notNull().defaultNow(),
    // The kind of that last event, so a list can show a resend without loading events.
    // Migration 0004 fills it in for existing rows; the default serves inserts from older
    // replicas.
    lastEventKind: eventKind().notNull().default("fired"),
    notificationCount: integer().notNull().default(1),
  },
  (table) => [
    // Also serves "every occurrence of this alert": its leading columns are the identity.
    unique("occurrences_identity").on(
      table.channelId,
      table.source,
      table.sourceKey,
      table.startsAt,
    ),
    // Channel lists, newest change first, paginated by (last_event_at, id).
    index("occurrences_channel_last_event").on(
      table.channelId,
      table.lastEventAt.desc(),
      table.id.desc(),
    ),
    // The cross-channel list (GET /api/occurrences), in the same order.
    index("occurrences_last_event").on(table.lastEventAt.desc(), table.id.desc()),
    // ...and that list filtered by status (?status=), so firing rows aren't found by
    // scanning past every resolved one.
    index("occurrences_status_last_event").on(
      table.status,
      table.lastEventAt.desc(),
      table.id.desc(),
    ),
    check(
      "occurrences_end_matches_status",
      sql`(${table.status} = 'firing') = (${table.endsAt} is null)`,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurrenceId: bigint({ mode: "number" })
      .notNull()
      .references(() => occurrences.id),
    kind: eventKind().notNull(),
    // Null: a notification caused it. `vanished`: Achtung resolved the occurrence because
    // its Alertmanager no longer had it (ADR 0014).
    cause: eventCause(),
    recordedAt: timestamptz().notNull(),
    // The time a `reminder_set` event set the reminder for (ADR 0025); null otherwise.
    remindAt: timestamptz(),
  },
  (table) => [
    index("events_occurrence_id").on(table.occurrenceId),
    // The home view counts the last day's events (noisiest alerts). Without it, every
    // refresh would scan the whole history, which only grows.
    index("events_recorded_at").on(table.recordedAt),
    // Compared as text: a new enum value can't be used in the transaction that adds it,
    // and the migration that added `reminder_set` also adds this.
    check(
      "events_remind_at_matches_kind",
      sql`(${table.kind}::text = 'reminder_set') = (${table.remindAt} is not null)`,
    ),
  ],
);

/**
 * The reminder pending on an occurrence (ADR 0025): at `remindAt` the server records a
 * `reminded` event, which resurfaces it, and deletes the row. One per occurrence: setting
 * another replaces it. Shared by every client, as there are no users (ADR 0002).
 */
export const reminders = pgTable(
  "reminders",
  {
    occurrenceId: bigint({ mode: "number" })
      .primaryKey()
      .references(() => occurrences.id),
    remindAt: timestamptz().notNull(),
  },
  // The sweep finds the due ones by time.
  (table) => [index("reminders_remind_at").on(table.remindAt)],
);

/**
 * Alert names the Home views leave out (ADR 0011): one list shared by every client, as
 * there are no users (ADR 0002). Migration 0006 seeds it.
 */
export const ignoredAlertNames = pgTable("ignored_alert_names", {
  // An alertname, matched exactly and case-sensitively.
  name: text().primaryKey(),
  createdAt: timestamptz().notNull(),
});

/**
 * Plugins' processes as they registered themselves (ADR 0022). `actions` is what each
 * offers, parsed on the way out.
 */
export const alertHandlers = pgTable("alert_handlers", {
  id: text().primaryKey(),
  name: text().notNull(),
  version: text().notNull(),
  actions: jsonb().notNull(),
  registeredAt: timestamptz().notNull(),
  // Its last register, claim or progress call: connected while this is recent.
  lastSeenAt: timestamptz().notNull(),
});

export const handoverState = pgEnum("handover_state", [
  "requested",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
]);

/** One occurrence handed over to one action of one handler (ADR 0022). Never deleted. */
export const handovers = pgTable(
  "handovers",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurrenceId: bigint({ mode: "number" })
      .notNull()
      .references(() => occurrences.id),
    // No reference: a handover outlives its handler's registration, so it carries the
    // handler's name and version and the action's title itself.
    handlerId: text().notNull(),
    handlerName: text().notNull(),
    handlerVersion: text().notNull(),
    actionId: text().notNull(),
    actionTitle: text().notNull(),
    // The action's timeout when asked; the deadline is the claim plus this.
    timeoutSeconds: integer().notNull(),
    state: handoverState().notNull(),
    requestedAt: timestamptz().notNull(),
    claimedAt: timestamptz(),
    leaseExpiresAt: timestamptz(),
    deadlineAt: timestamptz(),
    finishedAt: timestamptz(),
    // What the claiming handler must send with its later calls. Never returned by a read.
    claimToken: text(),
    // What was handed over: the occurrence, its events and its other occurrences as they
    // were at the claim.
    snapshot: jsonb(),
    summary: text(),
    body: text(),
    links: jsonb(),
    error: text(),
  },
  (table) => [
    index("handovers_occurrence_id").on(table.occurrenceId, table.id.desc()),
    // At most one handover of an action is active for an occurrence; also finds the active.
    uniqueIndex("handovers_one_active")
      .on(table.occurrenceId, table.handlerId, table.actionId)
      .where(sql`${table.state} in ('requested', 'running')`),
    index("handovers_active")
      .on(table.state)
      .where(sql`${table.state} in ('requested', 'running')`),
    check(
      "handovers_finished_matches_state",
      sql`(${table.state} in ('requested', 'running')) = (${table.finishedAt} is null)`,
    ),
    check(
      "handovers_claimed_matches_state",
      sql`${table.state} = 'cancelled' or (${table.state} in ('requested', 'expired')) = (${table.claimedAt} is null)`,
    ),
    check(
      "handovers_running_has_lease",
      sql`${table.state} <> 'running' or (${table.leaseExpiresAt} is not null and ${table.deadlineAt} is not null and ${table.claimToken} is not null)`,
    ),
  ],
);

/** What a handler reported while working on a handover, append-only. */
export const handoverProgress = pgTable(
  "handover_progress",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    handoverId: bigint({ mode: "number" })
      .notNull()
      .references(() => handovers.id),
    message: text().notNull(),
    recordedAt: timestamptz().notNull(),
  },
  (table) => [index("handover_progress_handover_id").on(table.handoverId, table.id)],
);
