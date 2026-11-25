// The shapes of the handler API (/api/handler/v0), as api/openapi.yaml has them. A
// handler ignores fields it doesn't know, so these list only what it may rely on.

export type Severity = "critical" | "warning" | "info" | "unknown";

/** An alert's occurrence, as the Achtung API returns it. Its text is untrusted. */
export interface Occurrence {
  readonly id: number;
  readonly instance: string;
  readonly channel: string;
  readonly source: string;
  readonly sourceKey: string;
  readonly status: "firing" | "resolved";
  readonly severity: Severity;
  readonly title: string;
  readonly summary: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly links: readonly { readonly kind: string; readonly url: string }[];
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly firstReceivedAt: string;
  readonly lastReceivedAt: string;
  readonly lastEventAt: string;
  readonly lastEventKind: string;
  readonly notificationCount: number;
  readonly silencedUntil: string | null;
}

export interface OccurrenceEvent {
  readonly id: number;
  readonly kind: string;
  readonly cause: string | null;
  readonly recordedAt: string;
  /** The time a `reminder_set` event set its reminder for. */
  readonly remindAt?: string | null;
}

/** Which alerts an action is for. Every part given must match; none given: every alert. */
export interface ActionScope {
  readonly instances?: readonly string[];
  readonly severities?: readonly Severity[];
  /** Each label must be there with exactly this value. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** An action as a handler registers it: a button on the alerts it applies to. */
export interface ActionRegistration {
  /** Lowercase letters, digits and dashes; unique within the handler. */
  readonly id: string;
  /** What the button says, at most 40 characters. */
  readonly title: string;
  /** The button's help text, at most 200 characters. */
  readonly description?: string;
  /** How long one handover may run, 60 to 3600 seconds; 900 when left out. */
  readonly timeoutSeconds?: number;
  readonly appliesTo?: ActionScope;
}

export interface Registration {
  readonly name: string;
  readonly version: string;
  readonly actions: readonly ActionRegistration[];
}

/** A handover this handler claimed: its to run, and nobody else's. */
export interface ClaimedHandover {
  readonly id: number;
  /** Which of the handler's actions was asked for. */
  readonly action: string;
  /** Sent as the `Achtung-Claim` header with every later call for this handover. */
  readonly claimToken: string;
  /** Call progress at least this often, or the handover fails as "handler lost". */
  readonly leaseSeconds: number;
  readonly deadlineAt: string;
  readonly requestedAt: string;
  readonly occurrence: Occurrence;
  /** Oldest first. */
  readonly events: readonly OccurrenceEvent[];
  /** Other occurrences of the same alert, newest first. */
  readonly otherOccurrences: readonly Occurrence[];
}

export type HandoverState =
  | "requested"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "expired";

export interface HandoverLink {
  readonly title: string;
  /** An http or https URL, without credentials. */
  readonly url: string;
}

/** What a handler answers a handover with. */
export type HandoverResult =
  | {
      readonly outcome: "succeeded";
      /** One line of plain text, at most 300 characters. */
      readonly summary: string;
      /** Markdown, at most 64 KiB. Clients render it as text. */
      readonly body: string;
      /** At most 10. */
      readonly links?: readonly HandoverLink[];
    }
  | { readonly outcome: "failed"; readonly error: string };
