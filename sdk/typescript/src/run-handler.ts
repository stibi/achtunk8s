import {
  type ClientOptions,
  HandlerApiError,
  type HandlerClient,
  handlerClient,
} from "./client.ts";
import type {
  ActionRegistration,
  ClaimedHandover,
  HandoverResult,
  HandoverState,
} from "./protocol.ts";
import { clean, cut, oneLine } from "./text.ts";

/** What an action's `handle` gets besides the handover. */
export interface HandleContext {
  /** Tells the person waiting what is going on, in a line of at most 500 characters. */
  progress(message: string): Promise<void>;
  /**
   * Aborts when the work should stop: the handover was cancelled, timed out or lost its
   * lease, or the handler is stopping. Its `reason` says which.
   */
  readonly signal: AbortSignal;
}

/** An action a handler offers, with the code that carries it out. */
export interface Action extends ActionRegistration {
  /**
   * Does the work and returns the result. Throwing fails the handover with the error's
   * message. The alert's labels and annotations are untrusted text.
   */
  handle(handover: ClaimedHandover, context: HandleContext): Promise<HandoverResult>;
}

/** What `runHandler` reports while it runs, for logging. */
export type HandlerEvent =
  | { readonly kind: "registered" }
  | { readonly kind: "claimed"; readonly handover: number; readonly action: string }
  | { readonly kind: "ended"; readonly handover: number; readonly outcome: string }
  /** The handover ended on the server before the work did: its state there. */
  | { readonly kind: "stopped"; readonly handover: number; readonly state: string }
  | { readonly kind: "error"; readonly during: string; readonly error: unknown };

export interface HandlerOptions extends ClientOptions {
  /** Shown in the client, at most 60 characters. */
  readonly name: string;
  /** The handler's own version. */
  readonly version: string;
  readonly actions: readonly Action[];
  /** Handovers worked on at once; 1 when left out. */
  readonly maxConcurrent?: number;
  /** Stops the handler: running work is told to stop, then `runHandler` returns. */
  readonly signal?: AbortSignal;
  /**
   * How long running work gets to stop after `signal` aborted, before `runHandler` returns
   * without it; 10 seconds when left out. Work that ignores its signal is left behind, and
   * its handover fails on the server as "handler lost".
   */
  readonly stopGraceSeconds?: number;
  /** How long a claim waits for a handover, 1 to 30 seconds; 10 when left out. */
  readonly waitSeconds?: number;
  /** What the loop does, for your logs. Left out, errors are written to stderr. */
  readonly onEvent?: (event: HandlerEvent) => void;
  /** A client to use instead of one made from `server`, `id` and `token`. */
  readonly client?: HandlerClient;
}

const maxPause = 30_000;

/** Errors go to stderr unless the handler takes the events itself: none is swallowed. */
function toStderr(event: HandlerEvent): void {
  if (event.kind === "error") {
    const reason = event.error instanceof Error ? event.error.message : String(event.error);
    process.stderr.write(`achtung handler: ${event.during}: ${reason}\n`);
  }
}

/** A refusal that asking again won't change: a wrong token or an invalid registration. */
const isFinal = (error: unknown) =>
  error instanceof HandlerApiError && [400, 401, 403].includes(error.status);

/**
 * Runs a handler until `signal` aborts: registers its actions, claims handovers, keeps
 * each one's lease alive while `handle` works, and posts what `handle` returns. Outages of
 * the server are retried with a growing pause. It rejects when the server refuses the
 * handler for good: its token (401, 403) or its registration (400).
 */
export async function runHandler(options: HandlerOptions): Promise<void> {
  const client = options.client ?? handlerClient(options);
  const stopping = options.signal ?? new AbortController().signal;
  const report = options.onEvent ?? toStderr;
  const waitSeconds = Math.min(30, Math.max(1, options.waitSeconds ?? 10));
  const running = new Set<Promise<void>>();
  const registration = {
    name: options.name,
    version: options.version,
    actions: options.actions.map(({ handle: _, ...action }) => action),
  };
  let registered = false;

  /** One round of the loop. Returns whether it went well, so the pause resets. */
  const round = async (): Promise<void> => {
    if (!registered) {
      await client.register(registration);
      registered = true;
      report({ kind: "registered" });
    }
    if (running.size >= (options.maxConcurrent ?? 1)) {
      await untilAborted(stopping, Promise.race(running));
      return;
    }
    // Its own time limit: a connection that died silently would hang the loop for minutes.
    const claim = await client.claim(
      waitSeconds,
      AbortSignal.any([stopping, AbortSignal.timeout((waitSeconds + 15) * 1000)]),
    );
    if (claim.kind === "unregistered") {
      registered = false;
    } else if (claim.kind === "busy") {
      throw new Error("too many claims are waiting on the server");
    } else if (claim.kind === "claimed") {
      const work = workOn(client, options, claim.handover, stopping, report).finally(() =>
        running.delete(work),
      );
      running.add(work);
    }
  };

  await repeated(round, stopping, report);
  await Promise.race([Promise.all(running), sleep((options.stopGraceSeconds ?? 10) * 1000)]);
}

/** Runs `round` until `stopping` aborts, pausing longer after each failure in a row. */
async function repeated(
  round: () => Promise<void>,
  stopping: AbortSignal,
  report: (event: HandlerEvent) => void,
): Promise<void> {
  let pause = 0;
  while (!stopping.aborted) {
    try {
      await round();
      pause = 0;
    } catch (error) {
      if (isFinal(error)) {
        throw error;
      }
      if (!stopping.aborted) {
        report({ kind: "error", during: "claiming", error });
        pause = nextPause(pause);
        await untilAborted(stopping, sleep(pause));
      }
    }
  }
}

const nextPause = (pause: number) => Math.min(maxPause, Math.max(1000, pause * 2));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Waits for `work`, or for `signal` to abort, whichever comes first. */
async function untilAborted(signal: AbortSignal, work: Promise<unknown>): Promise<void> {
  if (signal.aborted) {
    return;
  }
  let stop = () => {};
  const aborted = new Promise<void>((resolve) => {
    stop = resolve;
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** Why work on a handover should stop: where the handover is, or that the handler stops. */
export class HandoverStopped extends Error {
  readonly state: HandoverState | "stopping";

  constructor(state: HandoverState | "stopping") {
    super(state === "stopping" ? "The handler is stopping" : `The handover is ${state}`);
    this.name = "HandoverStopped";
    this.state = state;
  }
}

/** Carries one handover out: `handle`, with the lease kept alive, then the result. */
async function workOn(
  client: HandlerClient,
  options: HandlerOptions,
  handover: ClaimedHandover,
  stopping: AbortSignal,
  report: (event: HandlerEvent) => void,
): Promise<void> {
  report({ kind: "claimed", handover: handover.id, action: handover.action });
  const stop = new AbortController();
  const stopFor = (state: HandoverState | "stopping") => stop.abort(new HandoverStopped(state));
  const onStopping = () => stopFor("stopping");
  stopping.addEventListener("abort", onStopping, { once: true });
  if (stopping.aborted) {
    onStopping();
  }
  /**
   * Renews the lease; the server's answer says whether to go on. A call that fails is
   * reported, not thrown: the next one may get through, and a status line that didn't
   * must not fail the work.
   */
  const beat = async (message?: string) => {
    try {
      const state = await client.progress(handover, message);
      if (state !== "running") {
        stopFor(state);
      }
    } catch (error) {
      report({ kind: "error", during: `renewing handover ${handover.id}`, error });
      // The server no longer takes this handover from us: no result would be accepted.
      if (error instanceof HandlerApiError && [403, 404].includes(error.status)) {
        stopFor("failed");
      }
    }
  };
  // Four times per lease, so a lost call or two doesn't lose the handover.
  const heartbeat = setInterval(() => void beat(), (handover.leaseSeconds * 1000) / 4);
  try {
    const result = await handled(options, handover, {
      signal: stop.signal,
      progress: async (message) => {
        const line = cut(oneLine(message), 500);
        if (line !== "") {
          await beat(line);
        }
      },
    });
    if (stop.signal.reason instanceof HandoverStopped && stop.signal.reason.state !== "stopping") {
      report({ kind: "stopped", handover: handover.id, state: stop.signal.reason.state });
      return;
    }
    await answer(client, handover, result, report, stop.signal);
  } catch (error) {
    report({ kind: "error", during: `handover ${handover.id}`, error });
  } finally {
    clearInterval(heartbeat);
    stopping.removeEventListener("abort", onStopping);
  }
}

/** What `handle` returned, or a failure for what it threw or for an action nobody has. */
async function handled(
  options: HandlerOptions,
  handover: ClaimedHandover,
  context: HandleContext,
): Promise<HandoverResult> {
  const action = options.actions.find((candidate) => candidate.id === handover.action);
  if (action === undefined) {
    return { outcome: "failed", error: `This handler has no action ${handover.action}` };
  }
  try {
    return await action.handle(handover, context);
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** A result within the server's limits: cleaned, and cut where it is too long. */
function fitted(result: HandoverResult): HandoverResult {
  if (result.outcome === "failed") {
    return {
      outcome: "failed",
      error: cut(clean(result.error).trim(), 2000) || "The handler failed",
    };
  }
  return {
    outcome: "succeeded",
    summary: cut(oneLine(result.summary), 300) || "Done",
    body: cut(result.body, 65_536),
    links: (result.links ?? []).slice(0, 10).map(({ title, url }) => ({
      title: cut(clean(title).trim(), 100) || cut(url, 100),
      url,
    })),
  };
}

/**
 * Posts `result` until the server has an answer for it: an outage is retried with a
 * growing pause, since the same result sent again is answered as before. Gives up when the
 * handover ended on the server, or at `giveUpAt`.
 */
async function posted(
  client: HandlerClient,
  handover: ClaimedHandover,
  result: HandoverResult,
  report: (event: HandlerEvent) => void,
  stop: AbortSignal,
  giveUpAt: number,
): Promise<Awaited<ReturnType<HandlerClient["answer"]>>> {
  const endedOnServer = () =>
    stop.reason instanceof HandoverStopped && stop.reason.state !== "stopping";
  for (let pause = 0; ; ) {
    try {
      return await client.answer(handover, result);
    } catch (error) {
      report({ kind: "error", during: `answering handover ${handover.id}`, error });
      pause = nextPause(pause);
      if (endedOnServer() || isFinal(error) || Date.now() + pause > giveUpAt) {
        return { kind: "too-late" };
      }
      await sleep(pause);
    }
  }
}

async function answer(
  client: HandlerClient,
  handover: ClaimedHandover,
  result: HandoverResult,
  report: (event: HandlerEvent) => void,
  stop: AbortSignal,
): Promise<void> {
  // By this machine's clock, which needn't agree with the server's: the time the server
  // gave the handover from when it was asked for, counted from now. Past it, the server
  // has timed the handover out.
  const allowed =
    new Date(handover.deadlineAt).getTime() - new Date(handover.requestedAt).getTime();
  const giveUpAt = Date.now() + allowed;
  const sent = fitted(result);
  let answered = await posted(client, handover, sent, report, stop, giveUpAt);
  let outcome = sent.outcome;
  if (answered.kind === "refused") {
    // E.g. a link that isn't http(s): the person waiting still learns what happened.
    const reason = answered.reason;
    outcome = "failed";
    const error = cut(`The server refused the handler's result: ${reason}`, 2000);
    answered = await posted(client, handover, { outcome, error }, report, stop, giveUpAt);
    if (answered.kind === "refused") {
      report({ kind: "error", during: `answering handover ${handover.id}`, error: reason });
      return;
    }
  }
  report(
    answered.kind === "ended"
      ? { kind: "ended", handover: handover.id, outcome }
      : { kind: "stopped", handover: handover.id, state: "ended before the result" },
  );
}
