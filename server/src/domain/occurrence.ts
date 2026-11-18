import type { AlertState, IncomingAlert } from "./alert.ts";
import type { ChannelSlug, InstanceName } from "./channel.ts";

type OccurrenceStatus = AlertState["status"];

/**
 * What happened to an occurrence that is news: it moves the occurrence's `lastEventAt`,
 * so it resurfaces. `resent` is a repeat notification for an alert still firing, counted
 * at most once per `resendQuietPeriodMs` (ADR 0009). `reminded`: a reminder set on it
 * came due (ADR 0025).
 */
export type ChangeKind = "fired" | "resolved" | "reopened" | "resent" | "reminded";

/**
 * Something that happened to an occurrence. Events make up an alert's history. Setting
 * and cancelling a reminder are in it too, but they aren't news: they leave
 * `lastEventAt` alone (ADR 0025).
 */
export type EventKind = ChangeKind | "reminder_set" | "reminder_cancelled";

/**
 * Why Achtung recorded an event that no notification caused: `vanished`, the occurrence was
 * gone from its Alertmanager, so Achtung resolved it (ADR 0014).
 */
export type EventCause = "vanished";

/** A repeat within this long of the occurrence's last event is not news. */
export const resendQuietPeriodMs = 60 * 60 * 1000;

/**
 * What a notification with `incoming` status, received at `now`, means for an occurrence
 * that is currently `current` (null: not seen before). Null means nothing happened: the
 * notification updates the occurrence but is not news.
 */
export function eventFor(
  current: { readonly status: OccurrenceStatus; readonly lastEventAt: Date } | null,
  incoming: OccurrenceStatus,
  now: Date,
): Exclude<ChangeKind, "reminded"> | null {
  if (current?.status === incoming) {
    const quiet = now.getTime() - current.lastEventAt.getTime() < resendQuietPeriodMs;
    // Alertmanager sends a resolved alert once; only a firing one is resent as a reminder.
    return incoming === "firing" && !quiet ? "resent" : null;
  }
  if (incoming === "resolved") {
    return "resolved";
  }
  // Same startsAt firing again after a resolve: Alertmanager's resolve_timeout ended it
  // too early, so this is the same occurrence coming back, not a new one.
  return current === null ? "fired" : "reopened";
}

/** An occurrence as Achtung stores it: what the source reported plus what Achtung tracks. */
export type Occurrence = IncomingAlert & {
  readonly id: number;
  readonly instance: InstanceName;
  readonly channel: ChannelSlug;
  readonly source: string;
  readonly firstReceivedAt: Date;
  readonly lastReceivedAt: Date;
  /** When the last event happened. A repeat moves it only when it counts as `resent`. */
  readonly lastEventAt: Date;
  readonly lastEventKind: ChangeKind;
  readonly notificationCount: number;
  /** When the reminder pending on it comes due; null when none is (ADR 0025). */
  readonly remindAt: Date | null;
};

export type OccurrenceEvent = {
  readonly id: number;
  /** Null when a notification caused the event. */
  readonly cause: EventCause | null;
  readonly recordedAt: Date;
} & (
  | { readonly kind: Exclude<EventKind, "reminder_set">; readonly remindAt: null }
  /** The time the reminder was set for. */
  | { readonly kind: "reminder_set"; readonly remindAt: Date }
);
