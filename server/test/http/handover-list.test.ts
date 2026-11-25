import { describe, expect, it } from "vitest";
import { getJson } from "../api.ts";
import { agent, cancel, handOver, handoverApp, register } from "../handover.ts";

// Reading handovers (ADR 0022): the list of all of them, and an occurrence's own.

describe("GET /api/handovers", () => {
  async function appWithThree() {
    const context = await handoverApp();
    await register(context.app, "herdr-agent", {
      ...agent,
      actions: ["a", "b", "c"].map((id) => ({ id, title: id })),
    });
    for (const action of ["a", "b", "c"]) {
      await handOver(context.app, context.crashLoopId, "herdr-agent", action);
    }
    return context;
  }
  const ids = (body: { handovers: { id: number }[] }) => body.handovers.map(({ id }) => id);

  it("lists every handover, newest first, in pages", async () => {
    const { app } = await appWithThree();

    const first = (await getJson(app, "/api/handovers?limit=2")).body;
    const second = (await getJson(app, `/api/handovers?limit=2&cursor=${first.nextCursor}`)).body;

    expect(ids(first)).toEqual([3, 2]);
    expect(ids(second)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
  });

  it("ends without a cursor when the last page is full", async () => {
    const { app } = await appWithThree();

    expect((await getJson(app, "/api/handovers?limit=3")).body.nextCursor).toBeNull();
  });

  it("lists those in one state", async () => {
    const { app } = await appWithThree();
    await cancel(app, 2);

    expect(ids((await getJson(app, "/api/handovers?state=cancelled")).body)).toEqual([2]);
    expect(ids((await getJson(app, "/api/handovers?state=requested")).body)).toEqual([3, 1]);
  });

  it.each([
    ["a cursor it never issued", "cursor=nonsense"],
    ["a cursor that is JSON but no id", `cursor=${Buffer.from('"x"').toString("base64url")}`],
    ["a state that isn't one", "state=done"],
    ["a limit over 200", "limit=201"],
  ])("answers 400 for %s", async (_, query) => {
    const { app } = await handoverApp();

    expect((await getJson(app, `/api/handovers?${query}`)).status).toBe(400);
  });

  it("answers 404 for a handover that doesn't exist", async () => {
    const { app } = await handoverApp();

    expect((await getJson(app, "/api/handovers/7")).status).toBe(404);
  });

  it("lists at most the 20 newest in an occurrence's detail", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    for (let index = 0; index < 21; index++) {
      await handOver(app, crashLoopId);
      await cancel(app, index + 1);
    }

    const { handovers } = (await getJson(app, `/api/occurrences/${crashLoopId}`)).body;

    expect(handovers).toHaveLength(20);
    expect(handovers[0].id).toBe(21);
    expect(handovers.at(-1).id).toBe(2);
  });
});
