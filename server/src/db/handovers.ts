import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  Handover,
  HandoverLink,
  HandoverProgress,
  HandoverState,
  Overdue,
} from "../domain/handover.ts";
import type { Database, Transaction } from "./client.ts";
import { handoverProgress, handovers } from "./schema.ts";

type Row = typeof handovers.$inferSelect;

/** A handover with what only the server knows about it. */
export interface HandoverRecord {
  readonly handover: Handover;
  /** Null until a handler claimed it. */
  readonly claimToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly timeoutSeconds: number;
}

/** How a handover ends: by the clock, by a cancel, or with its handler's result. */
export type Ending =
  | Overdue
  | { readonly state: "cancelled"; readonly finishedAt: Date }
  | {
      readonly state: "succeeded";
      readonly finishedAt: Date;
      readonly summary: string;
      readonly body: string;
      readonly links: readonly HandoverLink[];
    };

// Serializes every change to handovers, so their limits and "one active per occurrence
// and action" need no further locking. Held to the end of the transaction.
const handoversLock = 0x4a11_0022;

export async function lockHandovers(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${handoversLock})`);
}

const links = z.array(z.object({ title: z.string(), url: z.string() }));

/** A column the row's state requires; missing means the check constraints were bypassed. */
function required<T>(row: Row, value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`Handover ${row.id} is ${row.state} without ${column}`);
  }
  return value;
}

function progressOf(row: Row): HandoverProgress {
  const claimedAt = () => required(row, row.claimedAt, "claimed_at");
  const finishedAt = () => required(row, row.finishedAt, "finished_at");
  switch (row.state) {
    case "requested":
      return { state: row.state };
    case "running":
      return {
        state: row.state,
        claimedAt: claimedAt(),
        deadlineAt: required(row, row.deadlineAt, "deadline_at"),
      };
    case "succeeded":
      return {
        state: row.state,
        claimedAt: claimedAt(),
        finishedAt: finishedAt(),
        summary: required(row, row.summary, "summary"),
        body: required(row, row.body, "body"),
        links: links.parse(row.links),
      };
    case "failed":
      return {
        state: row.state,
        claimedAt: claimedAt(),
        finishedAt: finishedAt(),
        error: required(row, row.error, "error"),
      };
    case "cancelled":
      return { state: row.state, claimedAt: row.claimedAt, finishedAt: finishedAt() };
    case "timed_out":
      return { state: row.state, claimedAt: claimedAt(), finishedAt: finishedAt() };
    case "expired":
      return { state: row.state, finishedAt: finishedAt() };
  }
}

async function toRecords(db: Database | Transaction, rows: readonly Row[]) {
  const lines =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(handoverProgress)
          .where(
            inArray(
              handoverProgress.handoverId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(asc(handoverProgress.id));
  return rows.map(
    (row): HandoverRecord => ({
      handover: {
        ...progressOf(row),
        id: row.id,
        occurrenceId: row.occurrenceId,
        handler: row.handlerId,
        handlerName: row.handlerName,
        handlerVersion: row.handlerVersion,
        action: row.actionId,
        title: row.actionTitle,
        requestedAt: row.requestedAt,
        progress: lines
          .filter((line) => line.handoverId === row.id)
          .map((line) => ({ at: line.recordedAt, message: line.message })),
      },
      claimToken: row.claimToken,
      leaseExpiresAt: row.leaseExpiresAt,
      timeoutSeconds: row.timeoutSeconds,
    }),
  );
}

const active = inArray(handovers.state, ["requested", "running"]);

export async function findHandover(
  db: Database | Transaction,
  id: number,
): Promise<HandoverRecord | null> {
  const [record] = await toRecords(
    db,
    await db.select().from(handovers).where(eq(handovers.id, id)),
  );
  return record ?? null;
}

/** Every handover requested or running, oldest first. */
export async function listActiveHandovers(tx: Database | Transaction): Promise<HandoverRecord[]> {
  return toRecords(tx, await tx.select().from(handovers).where(active).orderBy(asc(handovers.id)));
}

/** An occurrence's handovers, newest first. */
export async function listHandoversOf(
  db: Database,
  occurrenceId: number,
  limit: number,
): Promise<Handover[]> {
  const rows = await db
    .select()
    .from(handovers)
    .where(eq(handovers.occurrenceId, occurrenceId))
    .orderBy(desc(handovers.id))
    .limit(limit);
  return (await toRecords(db, rows)).map((record) => record.handover);
}

/** Every handover, newest first, after the one with id `after`. */
export async function listHandovers(
  db: Database,
  filter: {
    readonly state: HandoverState | null;
    readonly after: number | null;
    readonly limit: number;
  },
): Promise<Handover[]> {
  const rows = await db
    .select()
    .from(handovers)
    .where(
      and(
        filter.state === null ? undefined : eq(handovers.state, filter.state),
        filter.after === null ? undefined : lt(handovers.id, filter.after),
      ),
    )
    .orderBy(desc(handovers.id))
    .limit(filter.limit);
  return (await toRecords(db, rows)).map((record) => record.handover);
}

/** A new handover, `requested` at `now`. Returns its id. */
export async function insertHandover(
  tx: Transaction,
  handover: Pick<
    Row,
    | "occurrenceId"
    | "handlerId"
    | "handlerName"
    | "handlerVersion"
    | "actionId"
    | "actionTitle"
    | "timeoutSeconds"
  >,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .insert(handovers)
    .values({ ...handover, state: "requested", requestedAt: now })
    .returning({ id: handovers.id });
  if (row === undefined) {
    throw new Error("Inserting a handover returned no row");
  }
  return row.id;
}

/** Gives a requested handover to its handler: running, with a lease and a deadline. */
export async function claimHandover(
  tx: Transaction,
  id: number,
  claim: Pick<Row, "claimedAt" | "leaseExpiresAt" | "deadlineAt" | "claimToken" | "snapshot">,
): Promise<void> {
  await tx
    .update(handovers)
    .set({ ...claim, state: "running" })
    .where(eq(handovers.id, id));
}

export async function renewLease(tx: Transaction, id: number, leaseExpiresAt: Date) {
  await tx.update(handovers).set({ leaseExpiresAt }).where(eq(handovers.id, id));
}

export async function endHandover(tx: Transaction, id: number, ending: Ending): Promise<void> {
  await tx.update(handovers).set(ending).where(eq(handovers.id, id));
}

export async function recordProgress(
  tx: Transaction,
  handoverId: number,
  message: string,
  now: Date,
): Promise<void> {
  await tx.insert(handoverProgress).values({ handoverId, message, recordedAt: now });
}
