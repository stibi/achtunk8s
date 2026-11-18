import { asc, eq, lte, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { events, occurrences, reminders } from "./schema.ts";

// Lock order (ADR 0025): a reminder's row before its occurrence's, as ingest never takes a
// reminder's. Each due reminder goes in its own transaction, so a sweep holds at most one
// occurrence lock and can't deadlock with an ingest locking several.

/**
 * Sets the occurrence's reminder for `remindAt`, replacing one it has, and records a
 * `reminder_set` event. It leaves `lastEventAt` alone: setting a reminder isn't news.
 * Returns false when there is no such occurrence.
 */
export async function setReminder(
  tx: Transaction,
  occurrenceId: number,
  remindAt: Date,
  now: Date,
): Promise<boolean> {
  // A key share lock: the occurrence can't be deleted meanwhile, and ingest's lock still
  // waits for it rather than the other way round.
  const [found] = await tx
    .select({ id: occurrences.id })
    .from(occurrences)
    .where(eq(occurrences.id, occurrenceId))
    .for("key share");
  if (found === undefined) {
    return false;
  }
  await tx
    .insert(reminders)
    .values({ occurrenceId, remindAt })
    .onConflictDoUpdate({ target: reminders.occurrenceId, set: { remindAt } });
  await tx.insert(events).values({ occurrenceId, kind: "reminder_set", remindAt, recordedAt: now });
  return true;
}

/**
 * Cancels the occurrence's reminder and records a `reminder_cancelled` event. Without a
 * reminder pending, it does nothing.
 */
export async function cancelReminder(
  tx: Transaction,
  occurrenceId: number,
  now: Date,
): Promise<void> {
  const deleted = await tx
    .delete(reminders)
    .where(eq(reminders.occurrenceId, occurrenceId))
    .returning({ occurrenceId: reminders.occurrenceId });
  if (deleted.length > 0) {
    await tx.insert(events).values({ occurrenceId, kind: "reminder_cancelled", recordedAt: now });
  }
}

/**
 * Claims one reminder due at `now`, the longest overdue, and records its `reminded`
 * event, which resurfaces the occurrence. Returns the occurrence's id, or null when none
 * is due. The claim deletes the row in the same transaction as the event, so a reminder
 * fires once: a crash before the commit leaves it due, and another server running the
 * sweep skips the one claimed (`skip locked`) instead of firing it again.
 */
export function remindOneDue(db: Database, now: Date): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select({ occurrenceId: reminders.occurrenceId })
      .from(reminders)
      .where(lte(reminders.remindAt, now))
      .orderBy(asc(reminders.remindAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (due === undefined) {
      return null;
    }
    await tx.delete(reminders).where(eq(reminders.occurrenceId, due.occurrenceId));
    await tx
      .insert(events)
      .values({ occurrenceId: due.occurrenceId, kind: "reminded", recordedAt: now });
    // `now` was read before the update waited for the occurrence's lock: an ingest holding
    // it may have recorded a later event, which must not move back in time.
    await tx
      .update(occurrences)
      .set({
        lastEventAt: sql`greatest(${occurrences.lastEventAt}, ${now})`,
        lastEventKind: "reminded",
      })
      .where(eq(occurrences.id, due.occurrenceId));
    return due.occurrenceId;
  });
}
