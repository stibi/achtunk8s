import { randomBytes } from "node:crypto";
import {
  countHandlers,
  deleteHandler,
  findHandler,
  saveHandler,
  touchHandler,
} from "../db/alert-handlers.ts";
import {
  claimHandover,
  type Ending,
  endHandover,
  findHandover,
  type HandoverRecord,
  listActiveHandovers,
  recordProgress,
  renewLease,
} from "../db/handovers.ts";
import {
  type AlertAction,
  type AlertHandler,
  type Handover,
  type HandoverResult,
  type HandoverState,
  isConnected,
  isSameResult,
  leaseMs,
  maxHandlers,
  maxProgressEntries,
} from "../domain/handover.ts";
import type { ChangeHandovers } from "./handover-changes.ts";
import { stored } from "./handovers.ts";
import type { OccurrenceDetail } from "./inbox.ts";
import { sameSecret } from "./secrets.ts";

export interface HandlerRegistration {
  readonly name: string;
  readonly version: string;
  readonly actions: readonly AlertAction[];
}

export type RegisterHandlerResult =
  | { readonly kind: "registered"; readonly handler: AlertHandler }
  /** As many handlers are registered as the server allows. */
  | { readonly kind: "too-many" };

export type ClaimResult =
  | {
      readonly kind: "claimed";
      readonly handover: Extract<Handover, { state: "running" }>;
      /** What the handler sends with every later call for this handover. */
      readonly claimToken: string;
      /** The occurrence as the client API returns it: what is handed over. */
      readonly detail: OccurrenceDetail;
    }
  /** Nothing waits for this handler. */
  | { readonly kind: "none" }
  | { readonly kind: "unknown-handler" };

/** Who calls for a claimed handover: its claim token, and the handler its token names, if any. */
export interface Claimant {
  readonly claimToken: string;
  /** The handler the caller authenticated as (ADR 0023); null when tokens aren't required. */
  readonly handler: string | null;
}

type Refusal = { readonly kind: "not-found" } | { readonly kind: "not-the-claimant" };

export type ProgressResult = Refusal | { readonly kind: "ok"; readonly state: HandoverState };

export type ResultResult =
  | Refusal
  | { readonly kind: "ended"; readonly handover: Handover }
  /** It ended another way, or with another result, before this one arrived. */
  | { readonly kind: "conflict"; readonly state: HandoverState };

export const newClaimToken = () => randomBytes(32).toString("base64url");

/** Stores a handler's registration (ADR 0022): its name, version and actions. */
export function registerHandler(
  change: ChangeHandovers,
  id: string,
  registration: HandlerRegistration,
): Promise<RegisterHandlerResult> {
  return change<RegisterHandlerResult>(async (tx, now) => {
    if ((await findHandler(tx, id)) === null && (await countHandlers(tx)) >= maxHandlers) {
      return { value: { kind: "too-many" }, changed: false };
    }
    await saveHandler(tx, { id, ...registration }, now);
    const handler = { id, ...registration, lastSeenAt: now };
    return { value: { kind: "registered", handler }, changed: true };
  });
}

/** Forgets a handler: its actions are no longer offered. Its handovers stay. */
export function removeHandler(change: ChangeHandovers, id: string): Promise<void> {
  return change(async (tx) => {
    await deleteHandler(tx, id);
    return { value: undefined, changed: true };
  });
}

/** The oldest handover waiting for `handlerId`, marking the handler seen. */
function waitingFor(change: ChangeHandovers, handlerId: string) {
  return change<HandoverRecord | "unknown-handler" | null>(async (tx, now) => {
    const handler = await findHandler(tx, handlerId);
    if (handler === null) {
      return { value: "unknown-handler", changed: false };
    }
    await touchHandler(tx, handlerId, now);
    const active = await listActiveHandovers(tx);
    const waiting = active.find(
      ({ handover }) => handover.state === "requested" && handover.handler === handlerId,
    );
    // A handler that was away is back: its buttons work again, which clients should hear.
    const running = active.map((record) => record.handover);
    return { value: waiting ?? null, changed: !isConnected(handler, running, now) };
  });
}

/**
 * Gives the handler its oldest waiting handover, at most once: it is running from here on,
 * under a lease the handler renews with progress calls.
 */
export async function claimNextHandover(
  change: ChangeHandovers,
  readDetail: (occurrenceId: number) => Promise<OccurrenceDetail | null>,
  handlerId: string,
  claimToken: string,
): Promise<ClaimResult> {
  const waiting = await waitingFor(change, handlerId);
  if (waiting === "unknown-handler" || waiting === null) {
    return { kind: waiting === null ? "none" : "unknown-handler" };
  }
  const { id, occurrenceId } = waiting.handover;
  // Read before the claim, outside its transaction: it may ask Alertmanager for silences.
  const detail = await readDetail(occurrenceId);
  if (detail === null) {
    throw new Error(`Handover ${id} is for occurrence ${occurrenceId}, which doesn't exist`);
  }
  return change<ClaimResult>(async (tx, now) => {
    const record = await findHandover(tx, id);
    // Cancelled or expired since the read above.
    if (record?.handover.state !== "requested") {
      return { value: { kind: "none" }, changed: false };
    }
    await claimHandover(tx, id, {
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      deadlineAt: new Date(now.getTime() + record.timeoutSeconds * 1000),
      claimToken,
      snapshot: detail,
    });
    const handover = await stored(tx, id);
    if (handover.state !== "running") {
      throw new Error(`Handover ${id} was claimed but is ${handover.state}`);
    }
    return { value: { kind: "claimed", handover, claimToken, detail }, changed: true };
  });
}

/** Renews the lease of a running handover and records `message`, if any. */
export function reportProgress(
  change: ChangeHandovers,
  id: number,
  claimant: Claimant,
  message: string | null,
): Promise<ProgressResult> {
  return change<ProgressResult>(async (tx, now) => {
    const record = await findHandover(tx, id);
    const refusal = refusalFor(record, claimant);
    if (record === null || refusal !== null) {
      return { value: refusal ?? { kind: "not-found" }, changed: false };
    }
    const { handover } = record;
    await touchHandler(tx, handover.handler, now);
    if (handover.state !== "running") {
      return { value: { kind: "ok", state: handover.state }, changed: false };
    }
    await renewLease(tx, id, new Date(now.getTime() + leaseMs));
    const recorded = message !== null && handover.progress.length < maxProgressEntries;
    if (recorded) {
      await recordProgress(tx, id, message, now);
    }
    return { value: { kind: "ok", state: handover.state }, changed: recorded };
  });
}

/** Ends a running handover with its handler's result. A repeat of it changes nothing. */
export function answerHandover(
  change: ChangeHandovers,
  id: number,
  claimant: Claimant,
  result: HandoverResult,
): Promise<ResultResult> {
  return change<ResultResult>(async (tx, now) => {
    const record = await findHandover(tx, id);
    const refusal = refusalFor(record, claimant);
    if (record === null || refusal !== null) {
      return { value: refusal ?? { kind: "not-found" }, changed: false };
    }
    const { handover } = record;
    if (handover.state === "running") {
      await endHandover(tx, id, endingOf(result, now));
      return { value: { kind: "ended", handover: await stored(tx, id) }, changed: true };
    }
    return {
      value: isSameResult(handover, result)
        ? { kind: "ended", handover }
        : { kind: "conflict", state: handover.state },
      changed: false,
    };
  });
}

function endingOf(result: HandoverResult, finishedAt: Date): Ending {
  if (result.outcome === "failed") {
    return { state: "failed", finishedAt, error: result.error };
  }
  const { summary, body, links } = result;
  return { state: "succeeded", finishedAt, summary, body, links };
}

/** Why `claimant` may not act on the handover; null when it holds it. */
function refusalFor(record: HandoverRecord | null, claimant: Claimant): Refusal | null {
  if (record === null) {
    return { kind: "not-found" };
  }
  const holds =
    record.claimToken !== null &&
    sameSecret(claimant.claimToken, record.claimToken) &&
    (claimant.handler === null || claimant.handler === record.handover.handler);
  return holds ? null : { kind: "not-the-claimant" };
}
