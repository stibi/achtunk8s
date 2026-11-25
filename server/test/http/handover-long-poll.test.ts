import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { cancel, handOver, handoverApp, register, stateOf } from "../handover.ts";

// A claim may wait for a handover (ADR 0022): a long poll over a real connection.

async function listening(app: FastifyInstance): Promise<string> {
  return app.listen({ host: "127.0.0.1", port: 0 });
}

function claimWaiting(address: string, wait: number, signal?: AbortSignal) {
  return fetch(`${address}/api/handler/v0/handlers/herdr-agent/claim?wait=${wait}`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Lets the server reach the point where the claims sent so far are waiting. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("a claim that waits", () => {
  it("is answered as soon as a handover is asked for", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    const address = await listening(app);

    const waiting = claimWaiting(address, 30);
    await settled();
    const started = Date.now();
    await handOver(app, crashLoopId);
    const response = await waiting;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, action: "investigate" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is answered 204 when the wait ends with nothing", async () => {
    const { app } = await handoverApp();
    await register(app);
    const address = await listening(app);
    const started = Date.now();

    const response = await claimWaiting(address, 1);

    expect(response.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("stays waiting through changes that bring it nothing", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    await register(app, "llm");
    const address = await listening(app);

    const waiting = claimWaiting(address, 20);
    await settled();
    await handOver(app, crashLoopId, "llm");
    await cancel(app, 1);
    await handOver(app, crashLoopId);

    expect(await (await waiting).json()).toMatchObject({ id: 2 });
  });

  it("gives a handover to one of several waiting claims", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    const address = await listening(app);

    const waiting = [claimWaiting(address, 4), claimWaiting(address, 4), claimWaiting(address, 4)];
    await settled();
    await handOver(app, crashLoopId);
    const statuses = (await Promise.all(waiting)).map((response) => response.status);

    expect(statuses.sort()).toEqual([200, 204, 204]);
    // The two that got nothing wait their four seconds out.
  }, 15_000);

  it("refuses with 503 one more claim than may wait, but not one that needn't wait", async () => {
    const { app } = await handoverApp({
      handlers: { tokens: null, claims: { maxWaiting: 2 } },
    });
    await register(app);
    const address = await listening(app);
    const held = [claimWaiting(address, 20), claimWaiting(address, 20)];
    // Once both are waiting, a third is refused; until then it would be held too.
    let refused = await claimWaiting(address, 0);
    for (let tries = 0; refused.status !== 503 && tries < 50; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      refused = await claimWaiting(address, 1);
    }
    const immediate = await claimWaiting(address, 0);

    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "Too many claims are waiting" });
    expect(immediate.status).toBe(204);
    await app.close();
    await Promise.all(held);
  }, 15_000);

  it("takes nothing for a caller that hung up", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    const address = await listening(app);
    const controller = new AbortController();
    const waiting = claimWaiting(address, 30, controller.signal).catch(() => "aborted");
    await settled();

    controller.abort();
    expect(await waiting).toBe("aborted");
    await settled();
    await handOver(app, crashLoopId);
    await settled();

    expect(await stateOf(app, 1)).toBe("requested");
  });

  it("is ended with 204 when the server closes", async () => {
    const { app } = await handoverApp();
    await register(app);
    const address = await listening(app);
    const waiting = claimWaiting(address, 30);
    await settled();
    const started = Date.now();

    await app.close();

    expect((await waiting).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
