import { count, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { AlertAction, AlertHandler } from "../domain/handover.ts";
import type { Database, Transaction } from "./client.ts";
import { alertHandlers } from "./schema.ts";

// The actions column is JSON, parsed on the way out (golden principle 3).
const actions = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    timeoutSeconds: z.number(),
    appliesTo: z.object({
      instances: z.array(z.string()),
      severities: z.array(z.enum(["critical", "warning", "info", "unknown"])),
      labels: z.record(z.string(), z.string()),
    }),
  }),
);

function toHandler(row: typeof alertHandlers.$inferSelect): AlertHandler {
  const { id, name, version, lastSeenAt } = row;
  return { id, name, version, lastSeenAt, actions: actions.parse(row.actions) };
}

/** Every registered handler, by id. */
export async function listHandlers(db: Database | Transaction): Promise<AlertHandler[]> {
  const rows = await db.select().from(alertHandlers).orderBy(alertHandlers.id);
  return rows.map(toHandler);
}

export async function findHandler(
  db: Database | Transaction,
  id: string,
): Promise<AlertHandler | null> {
  const [row] = await db.select().from(alertHandlers).where(eq(alertHandlers.id, id));
  return row === undefined ? null : toHandler(row);
}

export async function countHandlers(tx: Transaction): Promise<number> {
  const [row] = await tx.select({ handlers: count() }).from(alertHandlers);
  return row?.handlers ?? 0;
}

/** Stores a handler's registration, new or changed, and marks it seen at `now`. */
export async function saveHandler(
  tx: Transaction,
  handler: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly actions: readonly AlertAction[];
  },
  now: Date,
): Promise<void> {
  const { id, name, version } = handler;
  const fields = { name, version, actions: handler.actions, lastSeenAt: now };
  await tx
    .insert(alertHandlers)
    .values({ id, ...fields, registeredAt: now })
    .onConflictDoUpdate({ target: alertHandlers.id, set: fields });
}

/** Marks a handler seen at `now`. False when it isn't registered. */
export async function touchHandler(
  db: Database | Transaction,
  id: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(alertHandlers)
    .set({ lastSeenAt: now })
    .where(eq(alertHandlers.id, id))
    .returning({ id: alertHandlers.id });
  return rows.length > 0;
}

export async function deleteHandler(db: Database | Transaction, id: string): Promise<void> {
  await db.delete(alertHandlers).where(eq(alertHandlers.id, id));
}

/** Forgets the handlers last seen before `before`. Returns how many. */
export async function deleteHandlersUnseenSince(
  db: Database | Transaction,
  before: Date,
): Promise<number> {
  const rows = await db
    .delete(alertHandlers)
    .where(lt(alertHandlers.lastSeenAt, before))
    .returning({ id: alertHandlers.id });
  return rows.length;
}
