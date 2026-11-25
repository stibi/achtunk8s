import type { Database, Transaction } from "../db/client.ts";
import {
  endHandover,
  type HandoverRecord,
  listActiveHandovers,
  lockHandovers,
} from "../db/handovers.ts";
import { overdue } from "../domain/handover.ts";
import type { Changes } from "./changes.ts";

/** What a step did: its answer, and whether clients have something to re-read. */
interface Step<T> {
  readonly value: T;
  readonly changed: boolean;
}

/**
 * Runs `step` as the only change to handovers at that moment, after ending the handovers
 * the clock has ended by then (ADR 0022): every call judges leases, deadlines and expiry
 * itself, so they are exact, and the sweep only records what nobody asked about. Publishes
 * `handovers` when the step or the clock changed something.
 */
export type ChangeHandovers = <T>(
  step: (tx: Transaction, now: Date) => Promise<Step<T>>,
) => Promise<T>;

export function handoverChanges(db: Database, changes: Changes, now: () => Date): ChangeHandovers {
  return async (step) => {
    const { value, changed } = await db.transaction(async (tx) => {
      await lockHandovers(tx);
      // After the lock: a change that waited for it doesn't run with an older time than
      // the one before it.
      const at = now();
      const ended = await endOverdue(tx, at);
      const done = await step(tx, at);
      return { value: done.value, changed: done.changed || ended };
    });
    if (changed) {
      changes.publish("handovers");
    }
    return value;
  };
}

/** Ends what the clock ended by `now`. Returns whether it ended any. */
async function endOverdue(tx: Transaction, now: Date): Promise<boolean> {
  let ended = false;
  for (const record of await listActiveHandovers(tx)) {
    const ending = overdueOf(record, now);
    if (ending !== null) {
      await endHandover(tx, record.handover.id, ending);
      ended = true;
    }
  }
  return ended;
}

function overdueOf({ handover, leaseExpiresAt }: HandoverRecord, now: Date) {
  if (handover.state === "requested") {
    return overdue(handover, now);
  }
  return handover.state === "running" && leaseExpiresAt !== null
    ? overdue({ state: "running", leaseExpiresAt, deadlineAt: handover.deadlineAt }, now)
    : null;
}
