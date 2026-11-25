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
/** The real server's lease; a test may run the fake with a shorter one. */
export const defaultLeaseMs = 2 * 60_000;
const idRule = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

function isWebUrl(value: unknown): boolean {
  const url =
    typeof value === "string" && value.length <= 2000 && URL.canParse(value)
      ? new URL(value)
      : null;
  return (
    url !== null && /^https?:$/.test(url.protocol) && url.username === "" && url.password === ""
  );
}

/** Text the server takes: a string of `min` to `max` characters once trimmed, without NUL. */
function isText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    !value.includes("\0") &&
    value.trim().length >= min &&
    value.trim().length <= max
  );
}

function isAction(action: ActionRegistration): boolean {
  const timeout = action.timeoutSeconds ?? 900;
  return (
    idRule.test(action.id) &&
    isText(action.title, 1, 40) &&
    isText(action.description ?? "", 0, 200) &&
    Number.isInteger(timeout) &&
    timeout >= 60 &&
    timeout <= 3600
  );
}

/** Whether the server would take this registration, by the limits of the handler API. */
export function isRegistration(id: string, registration: Registration): boolean {
  const actions = Array.isArray(registration.actions) ? registration.actions : [];
  return (
    idRule.test(id) &&
    isText(registration.name, 1, 60) &&
    isText(registration.version, 1, 40) &&
    actions.length >= 1 &&
    actions.length <= 10 &&
    new Set(actions.map((action) => action.id)).size === actions.length &&
    actions.every(isAction)
  );
}

/** A progress message the server takes: none, or 1 to 500 characters. */
export const isMessage = (message: unknown) => message === undefined || isText(message, 1, 500);

/** Why a result isn't one the server takes; null when it is. */
export function invalidResult(result: HandoverResult): string | null {
  if (result.outcome === "failed") {
    return isText(result.error, 1, 2000) ? null : "body/error";
  }
  if (result.outcome !== "succeeded") {
    return "body/outcome";
  }
  if (!isText(result.summary, 1, 300) || /[\r\n]/.test(result.summary)) {
    return "body/summary one line of at most 300 characters";
  }
  if (!isText(result.body, 0, 65_536) || result.body.length > 65_536) {
    return "body/body";
  }
  const links = result.links ?? [];
  return links.length <= 10 &&
    links.every((link) => isText(link.title, 1, 100) && isWebUrl(link.url))
    ? null
    : "body/links an http or https URL, without credentials";
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
