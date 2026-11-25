import { deleteHandlersUnseenSince, findHandler, listHandlers } from "../db/alert-handlers.ts";
import type { Database, Transaction } from "../db/client.ts";
import {
  endHandover,
  findHandover,
  insertHandover,
  listActiveHandovers,
  listHandovers,
  listHandoversOf,
} from "../db/handovers.ts";
import { findOccurrence } from "../db/queries.ts";
import {
  appliesTo,
  forgetHandlerAfterMs,
  type Handover,
  type HandoverState,
  isActive,
  isConnected,
  maxActiveHandovers,
} from "../domain/handover.ts";
import type { Occurrence } from "../domain/occurrence.ts";
import type { ChangeHandovers } from "./handover-changes.ts";

/** An action a handler offers for one occurrence: a button in the client. */
export interface ActionOffer {
  readonly handler: string;
  readonly handlerName: string;
  readonly action: string;
  readonly title: string;
  readonly description: string;
  /** Whether its handler is connected, so a handover would be taken. */
  readonly available: boolean;
  readonly lastSeenAt: Date;
}

export type CreateHandoverResult =
  | { readonly kind: "created"; readonly handover: Handover }
  /** One was requested or running already: that one, and nothing new. */
  | { readonly kind: "existing"; readonly handover: Handover }
  | { readonly kind: "not-found" }
  /** No such action, it isn't for this alert, or its handler isn't connected. */
  | { readonly kind: "not-offered"; readonly reason: string }
  /** As many handovers are active as the server allows. */
  | { readonly kind: "busy" };

export type CancelHandoverResult =
  | { readonly kind: "cancelled"; readonly handover: Handover }
  | { readonly kind: "not-found" }
  | { readonly kind: "ended"; readonly state: HandoverState };

export interface HandoverFilter {
  readonly state: HandoverState | null;
  /** The id the previous page ended with; null for the first page. */
  readonly after: number | null;
  readonly limit: number;
}

export interface HandoverPage {
  readonly handovers: readonly Handover[];
  /** The id the next page starts after; null when this is the last page. */
  readonly next: number | null;
}

const handoversShown = 20;

/** Reads see what the clock ended, like every other call. Returns the time it is. */
const settle = (change: ChangeHandovers) =>
  change(async (_tx, now) => ({ value: now, changed: false }));

/** The actions offered for an occurrence and its handovers, newest first (ADR 0022). */
export async function handoversOf(db: Database, change: ChangeHandovers, occurrence: Occurrence) {
  const now = await settle(change);
  const [handlers, handovers, active] = await Promise.all([
    listHandlers(db),
    listHandoversOf(db, occurrence.id, handoversShown),
    listActiveHandovers(db),
  ]);
  const running = active.map((record) => record.handover);
  const actions = handlers.flatMap((handler) =>
    handler.actions
      .filter((action) => appliesTo(action.appliesTo, occurrence))
      .map(
        (action): ActionOffer => ({
          handler: handler.id,
          handlerName: handler.name,
          action: action.id,
          title: action.title,
          description: action.description,
          available: isConnected(handler, running, now),
          lastSeenAt: handler.lastSeenAt,
        }),
      ),
  );
  return { actions, handovers };
}

/** The handler and its action, when it is offered for `occurrence`; else why not. */
async function offered(
  tx: Transaction,
  occurrence: Occurrence,
  handlerId: string,
  actionId: string,
) {
  const handler = await findHandler(tx, handlerId);
  const action = handler?.actions.find((candidate) => candidate.id === actionId);
  if (handler === null || action === undefined) {
    return "No handler offers this action";
  }
  return appliesTo(action.appliesTo, occurrence)
    ? { handler, action }
    : "This action isn't offered for this alert";
}

/**
 * Hands an occurrence over to an action. While a handover of that action is requested or
 * running for it, that one is the answer and nothing new is made.
 */
export async function createHandover(
  db: Database,
  change: ChangeHandovers,
  occurrenceId: number,
  handlerId: string,
  actionId: string,
): Promise<CreateHandoverResult> {
  const occurrence = await findOccurrence(db, occurrenceId);
  if (occurrence === null) {
    return { kind: "not-found" };
  }
  return change<CreateHandoverResult>(async (tx, now) => {
    const offer = await offered(tx, occurrence, handlerId, actionId);
    if (typeof offer === "string") {
      return refused(offer);
    }
    const active = await listActiveHandovers(tx);
    const existing = active.find(
      ({ handover }) =>
        handover.occurrenceId === occurrenceId &&
        handover.handler === handlerId &&
        handover.action === actionId,
    );
    if (existing !== undefined) {
      return { value: { kind: "existing", handover: existing.handover }, changed: false };
    }
    const running = active.map((record) => record.handover);
    if (!isConnected(offer.handler, running, now)) {
      return refused(`${offer.handler.name} isn't connected`);
    }
    if (active.length >= maxActiveHandovers) {
      return { value: { kind: "busy" }, changed: false };
    }
    const id = await insertHandover(
      tx,
      {
        occurrenceId,
        handlerId,
        handlerName: offer.handler.name,
        handlerVersion: offer.handler.version,
        actionId,
        actionTitle: offer.action.title,
        timeoutSeconds: offer.action.timeoutSeconds,
      },
      now,
    );
    return { value: { kind: "created", handover: await stored(tx, id) }, changed: true };
  });
}

function refused(reason: string) {
  return { value: { kind: "not-offered", reason } as const, changed: false };
}

/** Ends a requested or running handover now. Its handler learns it from its next call. */
export function cancelHandover(change: ChangeHandovers, id: number): Promise<CancelHandoverResult> {
  return change<CancelHandoverResult>(async (tx, now) => {
    const record = await findHandover(tx, id);
    if (record === null) {
      return { value: { kind: "not-found" }, changed: false };
    }
    if (!isActive(record.handover.state)) {
      return { value: { kind: "ended", state: record.handover.state }, changed: false };
    }
    await endHandover(tx, id, { state: "cancelled", finishedAt: now });
    return { value: { kind: "cancelled", handover: await stored(tx, id) }, changed: true };
  });
}

export async function getHandover(
  db: Database,
  change: ChangeHandovers,
  id: number,
): Promise<Handover | null> {
  await settle(change);
  return (await findHandover(db, id))?.handover ?? null;
}

/** Every handover, newest first: the record of what was handed over and what came back. */
export async function listAllHandovers(
  db: Database,
  change: ChangeHandovers,
  filter: HandoverFilter,
): Promise<HandoverPage> {
  await settle(change);
  // One extra row tells whether another page follows, without a count query.
  const rows = await listHandovers(db, { ...filter, limit: filter.limit + 1 });
  const handovers = rows.slice(0, filter.limit);
  return { handovers, next: rows.length > filter.limit ? (handovers.at(-1)?.id ?? null) : null };
}

/**
 * Records what the clock ended and nobody asked about, and forgets handlers long gone
 * (ADR 0022). Call it regularly.
 */
export function sweepHandovers(change: ChangeHandovers): Promise<void> {
  return change(async (tx, now) => {
    const before = new Date(now.getTime() - forgetHandlerAfterMs);
    return { value: undefined, changed: (await deleteHandlersUnseenSince(tx, before)) > 0 };
  });
}

/** A handover just written in `tx`. */
export async function stored(tx: Transaction, id: number): Promise<Handover> {
  const record = await findHandover(tx, id);
  if (record === null) {
    throw new Error(`Handover ${id} vanished inside its transaction`);
  }
  return record.handover;
}
