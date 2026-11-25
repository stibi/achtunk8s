import type { Database } from "../db/client.ts";
import type { Changes } from "./changes.ts";
import { handoverChanges } from "./handover-changes.ts";
import {
  answerHandover,
  claimNextHandover,
  type HandlerRegistration,
  newClaimToken,
  registerHandler,
  removeHandler,
  reportProgress,
} from "./handover-claims.ts";
import {
  cancelHandover,
  createHandover,
  getHandover,
  handoversOf,
  listAllHandovers,
  sweepHandovers,
} from "./handovers.ts";
import type { OccurrenceDetail } from "./inbox.ts";

/**
 * Handing alerts over to plugins (ADR 0022), bound to one database: what clients and
 * handlers do. `readDetail` reads an occurrence as the client API returns it, which is
 * what a claim hands over. Each change is published to `changes`.
 */
export function handoverServicesFor(
  db: Database,
  changes: Changes,
  now: () => Date,
  readDetail: (occurrenceId: number) => Promise<OccurrenceDetail | null>,
) {
  const change = handoverChanges(db, changes, now);
  return {
    of: (occurrence: Parameters<typeof handoversOf>[2]) => handoversOf(db, change, occurrence),
    create: (occurrenceId: number, handler: string, action: string) =>
      createHandover(db, change, occurrenceId, handler, action),
    cancel: (id: number) => cancelHandover(change, id),
    get: (id: number) => getHandover(db, change, id),
    list: (filter: Parameters<typeof listAllHandovers>[2]) => listAllHandovers(db, change, filter),
    register: (handler: string, registration: HandlerRegistration) =>
      registerHandler(change, handler, registration),
    remove: (handler: string) => removeHandler(change, handler),
    claim: (handler: string) => claimNextHandover(change, readDetail, handler, newClaimToken()),
    progress: (...args: DropFirst<Parameters<typeof reportProgress>>) =>
      reportProgress(change, ...args),
    answer: (...args: DropFirst<Parameters<typeof answerHandover>>) =>
      answerHandover(change, ...args),
    /** Records what the clock ended and forgets handlers long gone. Call it regularly. */
    sweep: () => sweepHandovers(change),
  };
}

type DropFirst<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest]
  ? Rest
  : never;
