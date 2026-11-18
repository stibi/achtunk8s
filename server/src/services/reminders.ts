import type { Database } from "../db/client.ts";
import { findOccurrence } from "../db/queries.ts";
import { cancelReminder, remindOneDue, setReminder } from "../db/reminders.ts";
import { reminderProblem } from "../domain/reminder.ts";
import type { SilencedOccurrence } from "../domain/silence.ts";
import type { Silences } from "./silences.ts";

export type ReminderResult =
  | { readonly kind: "changed"; readonly occurrence: SilencedOccurrence }
  | { readonly kind: "not-found" }
  /** The time is in the past, or too far ahead. */
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Sets the occurrence's reminder for `remindAt`, replacing one it has (ADR 0025), and
 * returns the occurrence with it.
 */
export async function setOccurrenceReminder(
  db: Database,
  silences: Silences,
  id: number,
  remindAt: Date,
  now: Date,
): Promise<ReminderResult> {
  const problem = reminderProblem(remindAt, now);
  if (problem !== null) {
    return { kind: "invalid", reason: problem };
  }
  const found = await db.transaction((tx) => setReminder(tx, id, remindAt, now));
  return found ? answer(db, silences, id) : { kind: "not-found" };
}

/** Cancels the occurrence's reminder, if it has one, and returns the occurrence. */
export async function cancelOccurrenceReminder(
  db: Database,
  silences: Silences,
  id: number,
  now: Date,
): Promise<ReminderResult> {
  await db.transaction((tx) => cancelReminder(tx, id, now));
  return answer(db, silences, id);
}

async function answer(db: Database, silences: Silences, id: number): Promise<ReminderResult> {
  const occurrence = await findOccurrence(db, id);
  const [annotated] = occurrence === null ? [] : await silences.annotate([occurrence]);
  return annotated === undefined
    ? { kind: "not-found" }
    : { kind: "changed", occurrence: annotated };
}

/**
 * Resurfaces every occurrence whose reminder is due at `now`, each with a `reminded`
 * event, and returns their ids. Call it regularly; one that was due while the server was
 * down comes due on the first call after.
 */
export async function remindDue(
  db: Database,
  now: () => Date,
  /** Filled as each comes due, so a sweep that fails part-way still says what it did. */
  reminded: number[] = [],
): Promise<number[]> {
  for (;;) {
    // The clock read for each claim, not once per sweep: a long sweep stamps late ones late.
    const id = await remindOneDue(db, now());
    if (id === null) {
      return reminded;
    }
    reminded.push(id);
  }
}
