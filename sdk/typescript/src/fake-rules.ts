import type {
  ActionRegistration,
  HandoverLink,
  HandoverResult,
  HandoverState,
  Occurrence,
  Registration,
} from "./protocol.ts";

// The handover rules of docs/handover-protocol.md, in memory: what the fake server
// answers from. The conformance suite holds it to what the real server does.

export const connectedWithinMs = 90_000;
const claimWithinMs = 10 * 60_000;
export const leaseMs = 2 * 60_000;
export const idRule = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Handler extends Registration {
  lastSeenAt: Date;
}

export interface StoredHandover {
  readonly id: number;
  readonly occurrenceId: number;
  readonly handler: string;
  readonly handlerName: string;
  readonly handlerVersion: string;
  readonly action: string;
  readonly title: string;
  readonly timeoutSeconds: number;
  readonly requestedAt: Date;
  state: HandoverState;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  deadlineAt: Date | null;
  finishedAt: Date | null;
  claimToken: string | null;
  summary: string | null;
  body: string | null;
  links: readonly HandoverLink[];
  error: string | null;
  readonly progress: { at: string; message: string }[];
}

/** An answer: an HTTP status and its JSON body, null for none. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export const answer = (status: number, body: unknown = null): Answer => ({ status, body });
export const refuse = (status: number, error: string) => answer(status, { error });
export const iso = (date: Date | null) => date?.toISOString() ?? null;

export function applies(action: ActionRegistration, occurrence: Occurrence): boolean {
  const { instances = [], severities = [], labels = {} } = action.appliesTo ?? {};
  return (
    (instances.length === 0 || instances.includes(occurrence.instance)) &&
    (severities.length === 0 || severities.includes(occurrence.severity)) &&
    Object.entries(labels).every(([name, value]) => occurrence.labels[name] === value)
  );
}

function isWebUrl(value: string): boolean {
  const url = URL.canParse(value) ? new URL(value) : null;
  return url !== null && /^https?:$/.test(url.protocol) && url.username === "";
}

/** Why a result isn't one the server takes; null when it is. */
export function invalidResult(result: HandoverResult): string | null {
  if (result.outcome === "failed") {
    return typeof result.error === "string" && result.error.trim() !== "" ? null : "body/error";
  }
  if (result.outcome !== "succeeded") {
    return "body/outcome";
  }
  if (
    typeof result.summary !== "string" ||
    result.summary.trim() === "" ||
    /[\r\n]/.test(result.summary)
  ) {
    return "body/summary";
  }
  const links = result.links ?? [];
  return typeof result.body === "string" &&
    links.length <= 10 &&
    links.every((link) => isWebUrl(link.url))
    ? null
    : "body/links an http or https URL";
}

/** How the clock alone ends a handover at `at`; null while it may go on. */
function overdue(handover: StoredHandover, at: Date) {
  const expiresAt = new Date(handover.requestedAt.getTime() + claimWithinMs);
  if (handover.state === "requested") {
    return expiresAt <= at ? { state: "expired", finishedAt: expiresAt, error: null } : null;
  }
  const { leaseExpiresAt, deadlineAt } = handover;
  if (handover.state !== "running" || leaseExpiresAt === null || deadlineAt === null) {
    return null;
  }
  if (deadlineAt <= at && deadlineAt <= leaseExpiresAt) {
    return { state: "timed_out", finishedAt: deadlineAt, error: null };
  }
  const error = "The handler stopped answering (handler lost)";
  return leaseExpiresAt <= at ? { state: "failed", finishedAt: leaseExpiresAt, error } : null;
}

/** Ends what the clock ended by `at`, as every call of the real server does first. */
export function settle(handovers: readonly StoredHandover[], at: Date): void {
  for (const handover of handovers) {
    Object.assign(handover, overdue(handover, at) ?? {});
  }
}

/** A handover as the API shows it: without what only the server knows. */
export function shown(handover: StoredHandover) {
  const { claimToken: _, leaseExpiresAt: __, timeoutSeconds: ___, ...rest } = handover;
  return {
    ...rest,
    requestedAt: iso(handover.requestedAt),
    claimedAt: iso(handover.claimedAt),
    deadlineAt: handover.state === "running" ? iso(handover.deadlineAt) : null,
    finishedAt: iso(handover.finishedAt),
  };
}

export const isActive = (handover: StoredHandover) =>
  handover.state === "requested" || handover.state === "running";
