import { onTestFinished } from "vitest";
import { type FakeServerOptions, startFakeServer } from "../src/fake-server.ts";

/** A fake server with a clock the test moves, closed when the test finishes. */
export async function fakeServer(options: Omit<FakeServerOptions, "now" | "port"> = {}) {
  let current = new Date("2026-11-15T10:00:00Z");
  const server = await startFakeServer({ ...options, now: () => current });
  onTestFinished(() => server.close());
  return {
    url: server.url,
    occurrenceId: 1,
    advance: (seconds: number) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

/** Waits until `condition` holds, for at most five seconds. */
export async function until(condition: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 200; tries++) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the condition never held");
}
