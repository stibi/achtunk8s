import {
  type Answer,
  answer,
  applies,
  connectedWithinMs,
  type Handler,
  idRule,
  invalidResult,
  isActive,
  iso,
  leaseMs,
  refuse,
  type StoredHandover,
  settle,
  shown,
} from "./fake-rules.ts";
import type { HandoverResult, Occurrence, Registration } from "./protocol.ts";

/**
 * The handover rules of docs/handover-protocol.md, in memory: what the fake server answers
 * from. The conformance suite holds it to what the real server does.
 */
export class FakeHandovers {
  readonly #handlers = new Map<string, Handler>();
  readonly #handovers: StoredHandover[] = [];
  readonly #occurrences: readonly Occurrence[];
  readonly #now: () => Date;

  constructor(occurrences: readonly Occurrence[], now: () => Date) {
    this.#occurrences = occurrences;
    this.#now = now;
  }

  /** The time it is, after ending what the clock ended. */
  #settled(): Date {
    const at = this.#now();
    settle(this.#handovers, at);
    return at;
  }

  #connected(handler: Handler, id: string, at: Date): boolean {
    return (
      at.getTime() - handler.lastSeenAt.getTime() < connectedWithinMs ||
      this.#handovers.some((handover) => handover.state === "running" && handover.handler === id)
    );
  }

  #occurrence(id: number | undefined): Occurrence | undefined {
    return this.#occurrences.find((candidate) => candidate.id === id);
  }

  /** The handover, when `claimToken` holds it; else the refusal. */
  #held(id: number, claimToken: string | undefined): StoredHandover | Answer {
    const handover = this.#handovers.find((candidate) => candidate.id === id);
    if (handover === undefined) {
      return refuse(404, "Handover not found");
    }
    return claimToken !== undefined && claimToken === handover.claimToken
      ? handover
      : refuse(403, "This handover isn't held with that claim token");
  }

  register(id: string, registration: Registration): Answer {
    const at = this.#settled();
    const actions = registration.actions ?? [];
    const valid =
      idRule.test(id) &&
      typeof registration.name === "string" &&
      registration.name.trim() !== "" &&
      typeof registration.version === "string" &&
      actions.length > 0 &&
      actions.every((action) => idRule.test(action.id) && typeof action.title === "string");
    if (!valid) {
      return refuse(400, "body/ an invalid registration");
    }
    this.#handlers.set(id, { ...registration, lastSeenAt: at });
    return answer(200, { id, ...registration });
  }

  remove(id: string): Answer {
    this.#handlers.delete(id);
    return answer(204);
  }

  detail(occurrenceId: number): Answer {
    const at = this.#settled();
    const occurrence = this.#occurrence(occurrenceId);
    if (occurrence === undefined) {
      return refuse(404, "Occurrence not found");
    }
    const actions = [...this.#handlers].flatMap(([id, handler]) =>
      handler.actions
        .filter((action) => applies(action, occurrence))
        .map((action) => ({
          handler: id,
          handlerName: handler.name,
          action: action.id,
          title: action.title,
          description: action.description ?? "",
          available: this.#connected(handler, id, at),
          lastSeenAt: handler.lastSeenAt.toISOString(),
        })),
    );
    const own = this.#handovers.filter((handover) => handover.occurrenceId === occurrenceId);
    return answer(200, {
      occurrence,
      events: [],
      otherOccurrences: [],
      actions,
      handovers: own.toReversed().map(shown),
    });
  }

  create(occurrenceId: number, handlerId: string, actionId: string): Answer {
    const at = this.#settled();
    const occurrence = this.#occurrence(occurrenceId);
    if (occurrence === undefined) {
      return refuse(404, "Occurrence not found");
    }
    const handler = this.#handlers.get(handlerId);
    const action = handler?.actions.find((candidate) => candidate.id === actionId);
    if (handler === undefined || action === undefined || !applies(action, occurrence)) {
      return refuse(409, "No handler offers this action for this alert");
    }
    const existing = this.#handovers.find(
      (handover) =>
        handover.occurrenceId === occurrenceId &&
        handover.handler === handlerId &&
        handover.action === actionId &&
        isActive(handover),
    );
    if (existing !== undefined) {
      return answer(200, shown(existing));
    }
    if (!this.#connected(handler, handlerId, at)) {
      return refuse(409, `${handler.name} isn't connected`);
    }
    const handover: StoredHandover = {
      id: this.#handovers.length + 1,
      occurrenceId,
      handler: handlerId,
      handlerName: handler.name,
      handlerVersion: handler.version,
      action: actionId,
      title: action.title,
      timeoutSeconds: action.timeoutSeconds ?? 900,
      requestedAt: at,
      state: "requested",
      claimedAt: null,
      leaseExpiresAt: null,
      deadlineAt: null,
      finishedAt: null,
      claimToken: null,
      summary: null,
      body: null,
      links: [],
      error: null,
      progress: [],
    };
    this.#handovers.push(handover);
    return answer(201, shown(handover));
  }

  get(id: number): Answer {
    this.#settled();
    const handover = this.#handovers.find((candidate) => candidate.id === id);
    return handover === undefined
      ? refuse(404, "Handover not found")
      : answer(200, shown(handover));
  }

  cancel(id: number): Answer {
    const at = this.#settled();
    const handover = this.#handovers.find((candidate) => candidate.id === id);
    if (handover === undefined) {
      return refuse(404, "Handover not found");
    }
    if (!isActive(handover)) {
      return refuse(409, `The handover is ${handover.state} already`);
    }
    Object.assign(handover, { state: "cancelled", finishedAt: at });
    return answer(200, shown(handover));
  }

  /** The handler's next handover; a 204 when nothing waits. */
  claim(handlerId: string): Answer {
    const at = this.#settled();
    const handler = this.#handlers.get(handlerId);
    if (handler === undefined) {
      return refuse(404, "Handler not registered");
    }
    handler.lastSeenAt = at;
    const handover = this.#handovers.find(
      (candidate) => candidate.state === "requested" && candidate.handler === handlerId,
    );
    const occurrence = this.#occurrence(handover?.occurrenceId);
    if (handover === undefined || occurrence === undefined) {
      return answer(204);
    }
    Object.assign(handover, {
      state: "running",
      claimedAt: at,
      leaseExpiresAt: new Date(at.getTime() + leaseMs),
      deadlineAt: new Date(at.getTime() + handover.timeoutSeconds * 1000),
      claimToken: `fake-claim-${handover.id}-${Math.random().toString(36).slice(2)}`,
    });
    return answer(200, {
      id: handover.id,
      action: handover.action,
      claimToken: handover.claimToken,
      leaseSeconds: leaseMs / 1000,
      deadlineAt: iso(handover.deadlineAt),
      requestedAt: iso(handover.requestedAt),
      occurrence,
      events: [],
      otherOccurrences: [],
    });
  }

  progress(id: number, claimToken: string | undefined, message: string | undefined): Answer {
    const at = this.#settled();
    const handover = this.#held(id, claimToken);
    if ("status" in handover) {
      return handover;
    }
    const handler = this.#handlers.get(handover.handler);
    if (handler !== undefined) {
      handler.lastSeenAt = at;
    }
    if (handover.state === "running") {
      handover.leaseExpiresAt = new Date(at.getTime() + leaseMs);
      if (message !== undefined && handover.progress.length < 200) {
        handover.progress.push({ at: at.toISOString(), message: message.trim() });
      }
    }
    return answer(200, { state: handover.state, leaseSeconds: leaseMs / 1000 });
  }

  result(id: number, claimToken: string | undefined, result: HandoverResult): Answer {
    const at = this.#settled();
    const handover = this.#held(id, claimToken);
    if ("status" in handover) {
      return handover;
    }
    const invalid = invalidResult(result);
    if (invalid !== null) {
      return refuse(400, invalid);
    }
    const fields =
      result.outcome === "succeeded"
        ? {
            summary: result.summary.trim(),
            body: result.body,
            links: result.links ?? [],
            error: null,
          }
        : { summary: null, body: null, links: [], error: result.error.trim() };
    if (handover.state === "running") {
      Object.assign(handover, { state: result.outcome, finishedAt: at, ...fields });
      return answer(200, shown(handover));
    }
    const { summary, body, links, error } = handover;
    const same =
      handover.state === result.outcome &&
      JSON.stringify({ summary, body, links, error }) === JSON.stringify(fields);
    return same
      ? answer(200, shown(handover))
      : refuse(409, `The handover is ${handover.state} already`);
  }
}
