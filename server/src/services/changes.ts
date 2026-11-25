/**
 * What changed, so a client re-reads that part instead of waiting for its next poll
 * (ADR 0019): occurrences (a notification arrived, or one resolved as vanished), silences
 * set or ended through Achtung, the shared settings, or handovers and the handlers offering
 * them (ADR 0022). Silences changed in Alertmanager itself aren't seen here; polling still
 * finds those.
 */
export type ChangeKind = "occurrences" | "silences" | "settings" | "handovers";

/** Telling subscribers what changed. In memory: every client of this process hears it. */
export interface Changes {
  publish(kind: ChangeKind): void;
  /** Calls `listener` with each change from now on, until the returned function is called. */
  subscribe(listener: (kind: ChangeKind) => void): () => void;
}

export function changesFeed(): Changes {
  const listeners = new Set<(kind: ChangeKind) => void>();
  return {
    publish(kind) {
      for (const listener of listeners) {
        listener(kind);
      }
    },
    subscribe(listener) {
      // Wrapped, so the same function subscribed twice is two subscriptions.
      const entry = (kind: ChangeKind) => listener(kind);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };
}
