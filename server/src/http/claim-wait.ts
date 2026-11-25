import type { FastifyInstance } from "fastify";
import { maxHandlers } from "../domain/handover.ts";
import type { Changes } from "../services/changes.ts";

export interface ClaimWaitOptions {
  /** Claims held open at once; one more that would have to wait is refused. */
  readonly maxWaiting?: number;
}

/** What became of a claim that may wait: what it found, or why it found nothing. */
export type Waited<T> =
  | { readonly kind: "found"; readonly value: T }
  /** The wait is over, or the server is closing. */
  | { readonly kind: "nothing" }
  | { readonly kind: "too-many-waiting" }
  /** The caller hung up; nothing was taken for it after that. */
  | { readonly kind: "gone" };

/** A connection as the wait needs it: whether it is gone, and when it goes. */
interface Connection {
  readonly destroyed?: boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

/**
 * Holds claim requests open until a handover may be waiting for them (ADR 0022): a long
 * poll on top of the change feed (ADR 0019). Closing the server ends every wait.
 */
export function claimWaits(app: FastifyInstance, changes: Changes, options: ClaimWaitOptions) {
  // Room for every handler to hold a claim or two.
  const { maxWaiting = 2 * maxHandlers } = options;
  const waiting = new Set<() => void>();
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
    for (const wake of [...waiting]) {
      wake();
    }
  });

  /** Resolves after `ms`, when `connection` closes, or when the returned `wake` is called. */
  const pause = (ms: number, connection: Connection, onWake: (wake: () => void) => void) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        connection.off("close", wake);
        waiting.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      connection.once("close", wake);
      waiting.add(wake);
      onWake(wake);
    });

  /** After an attempt found nothing: why to give up, or null to try again. */
  const idle = async <T>(
    until: number,
    watch: ReturnType<typeof watchHandovers>,
    connection: Connection,
  ): Promise<Waited<T> | null> => {
    const left = until - Date.now();
    if (left <= 0 || closing) {
      return { kind: "nothing" };
    }
    // A change during the attempt may be the handover it just missed: try again at once.
    if (watch.changed()) {
      return null;
    }
    if (waiting.size >= maxWaiting) {
      return { kind: "too-many-waiting" };
    }
    // Closed during the attempt: its close event has passed, so nothing would wake the wait.
    if (connection.destroyed === true) {
      return { kind: "gone" };
    }
    await pause(left, connection, watch.wakeWith);
    return null;
  };

  /** One attempt: what it found, why to give up, or null to try again. */
  const round = async <T>(
    attempt: () => Promise<T | null>,
    until: number,
    watch: ReturnType<typeof watchHandovers>,
    connection: Connection,
  ): Promise<Waited<T> | null> => {
    if (connection.destroyed === true) {
      return { kind: "gone" };
    }
    watch.reset();
    const value = await attempt();
    return value === null ? idle<T>(until, watch, connection) : { kind: "found", value };
  };

  /**
   * Calls `attempt` until it finds something, at most `waitMs` long: again after each
   * change to handovers. It asks whether the caller is still there before every attempt,
   * so nothing is taken for a connection that went away.
   */
  const wait = async <T>(
    attempt: () => Promise<T | null>,
    waitMs: number,
    connection: Connection,
  ): Promise<Waited<T>> => {
    const until = Date.now() + waitMs;
    const watch = watchHandovers(changes);
    try {
      let outcome: Waited<T> | null = null;
      while (outcome === null) {
        outcome = await round(attempt, until, watch, connection);
      }
      return outcome;
    } finally {
      watch.stop();
    }
  };
  /**
   * `isClosing`: answer with `connection: close` then, or the caller's kept-alive
   * connection holds the server open.
   */
  return { wait, isClosing: () => closing };
}

/** Whether handovers changed since `reset`, waking whoever `wakeWith` named when they do. */
function watchHandovers(changes: Changes) {
  let changed = false;
  let wake = () => {};
  const stop = changes.subscribe((kind) => {
    if (kind === "handovers") {
      changed = true;
      wake();
    }
  });
  return {
    changed: () => changed,
    reset: () => {
      changed = false;
    },
    wakeWith: (resume: () => void) => {
      wake = resume;
    },
    stop,
  };
}
