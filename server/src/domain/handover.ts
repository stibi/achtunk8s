import type { Severity } from "./alert.ts";
import { channelSlugRule } from "./channel.ts";

// Handing an alert over to a plugin (ADR 0022). A plugin's process is an alert handler: it
// registers the actions it offers, and a handover is one occurrence given to one action.

/** A handler's or an action's id: lowercase letters, digits and dashes, as for channels. */
export const handoverIdRule = channelSlugRule;

/** Which alerts an action is for. Every part given must match; an empty part matches all. */
export interface ActionScope {
  readonly instances: readonly string[];
  readonly severities: readonly Severity[];
  /** Each label must be there with exactly this value. */
  readonly labels: Readonly<Record<string, string>>;
}

/** Something a handler offers for an alert: a button in the client. */
export interface AlertAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** How long one handover may run before it times out. */
  readonly timeoutSeconds: number;
  readonly appliesTo: ActionScope;
}

/** A plugin's process, as it registered itself. */
export interface AlertHandler {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly actions: readonly AlertAction[];
  /** Its last register, claim or progress call. */
  readonly lastSeenAt: Date;
}

/** A handler that hasn't called for this long is not connected. */
const connectedWithinMs = 90_000;
/** A handover nobody claimed for this long expires. */
export const claimWithinMs = 10 * 60_000;
/** How long a claim, and each progress call after it, keeps a handover running. */
export const leaseMs = 2 * 60_000;
/** A handler not seen for this long is forgotten. */
export const forgetHandlerAfterMs = 30 * 24 * 60 * 60_000;
/** Handovers requested or running at once, on the whole server. */
export const maxActiveHandovers = 20;
export const maxHandlers = 50;
/** Progress lines kept per handover; later ones only renew the lease. */
export const maxProgressEntries = 200;

/**
 * Whether a handler would take a handover: it called within `connectedWithinMs`, or it
 * holds a running handover, whose lease it renews less often than that.
 */
export function isConnected(
  handler: Pick<AlertHandler, "id" | "lastSeenAt">,
  running: readonly Pick<Handover, "handler" | "state">[],
  now: Date,
): boolean {
  return (
    now.getTime() - handler.lastSeenAt.getTime() < connectedWithinMs ||
    running.some((handover) => handover.state === "running" && handover.handler === handler.id)
  );
}

export function appliesTo(
  scope: ActionScope,
  alert: {
    readonly instance: string;
    readonly severity: Severity;
    readonly labels: Readonly<Record<string, string>>;
  },
): boolean {
  return (
    (scope.instances.length === 0 || scope.instances.includes(alert.instance)) &&
    (scope.severities.length === 0 || scope.severities.includes(alert.severity)) &&
    Object.entries(scope.labels).every(([name, value]) => alert.labels[name] === value)
  );
}

export interface HandoverLink {
  readonly title: string;
  readonly url: string;
}

/** What a handler answers a handover with. */
export type HandoverResult =
  | {
      readonly outcome: "succeeded";
      readonly summary: string;
      readonly body: string;
      readonly links: readonly HandoverLink[];
    }
  | { readonly outcome: "failed"; readonly error: string };

/** Where a handover is, with exactly the facts that state has. */
export type HandoverProgress =
  | { readonly state: "requested" }
  | { readonly state: "running"; readonly claimedAt: Date; readonly deadlineAt: Date }
  | {
      readonly state: "succeeded";
      readonly claimedAt: Date;
      readonly finishedAt: Date;
      readonly summary: string;
      readonly body: string;
      readonly links: readonly HandoverLink[];
    }
  | {
      readonly state: "failed";
      readonly claimedAt: Date;
      readonly finishedAt: Date;
      readonly error: string;
    }
  /** `claimedAt` is null when it was cancelled before a handler took it. */
  | { readonly state: "cancelled"; readonly claimedAt: Date | null; readonly finishedAt: Date }
  | { readonly state: "timed_out"; readonly claimedAt: Date; readonly finishedAt: Date }
  | { readonly state: "expired"; readonly finishedAt: Date };

export type HandoverState = HandoverProgress["state"];

/** One occurrence handed over to one action of one handler. */
export type Handover = HandoverProgress & {
  readonly id: number;
  readonly occurrenceId: number;
  readonly handler: string;
  /** The handler's name and version, and the action's title, as they were when asked. */
  readonly handlerName: string;
  readonly handlerVersion: string;
  readonly action: string;
  readonly title: string;
  readonly requestedAt: Date;
  /** What the handler reported while working, oldest first. */
  readonly progress: readonly { readonly at: Date; readonly message: string }[];
};

export function isActive(state: HandoverState): state is "requested" | "running" {
  return state === "requested" || state === "running";
}

/** Why a handover whose handler stopped renewing its lease failed. */
export const handlerLost = "The handler stopped answering (handler lost)";

/** What the clock alone does to a handover: null while it may go on. */
export type Overdue =
  | { readonly state: "expired"; readonly finishedAt: Date }
  | { readonly state: "timed_out"; readonly finishedAt: Date }
  | { readonly state: "failed"; readonly finishedAt: Date; readonly error: string };

/**
 * How a handover ends at `now` without anyone acting: one waiting unclaimed for
 * `claimWithinMs` expires; a running one times out at its deadline, or fails when its lease
 * ran out first. It ended at that moment, not at `now`.
 */
export function overdue(
  handover:
    | { readonly state: "requested"; readonly requestedAt: Date }
    | { readonly state: "running"; readonly leaseExpiresAt: Date; readonly deadlineAt: Date },
  now: Date,
): Overdue | null {
  if (handover.state === "requested") {
    const expiresAt = new Date(handover.requestedAt.getTime() + claimWithinMs);
    return expiresAt <= now ? { state: "expired", finishedAt: expiresAt } : null;
  }
  const { leaseExpiresAt, deadlineAt } = handover;
  if (deadlineAt <= now && deadlineAt <= leaseExpiresAt) {
    return { state: "timed_out", finishedAt: deadlineAt };
  }
  return leaseExpiresAt <= now
    ? { state: "failed", finishedAt: leaseExpiresAt, error: handlerLost }
    : null;
}

/** Whether `result` is what `handover` already ended with: a repeat, not a second answer. */
export function isSameResult(handover: HandoverProgress, result: HandoverResult): boolean {
  if (handover.state === "succeeded" && result.outcome === "succeeded") {
    return (
      handover.summary === result.summary &&
      handover.body === result.body &&
      JSON.stringify(handover.links) === JSON.stringify(result.links)
    );
  }
  return (
    handover.state === "failed" && result.outcome === "failed" && handover.error === result.error
  );
}
