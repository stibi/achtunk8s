import { describe, expect, it } from "vitest";
import { getJson } from "../api.ts";
import { answer, cancel, claimedHandover, findings, progress, stateOf } from "../handover.ts";

// What the clock does to a running handover (ADR 0022): its lease and its deadline.

describe("a running handover", () => {
  it("fails as handler lost when its lease runs out, at that moment", async () => {
    const { app, clock, id, claimToken } = await claimedHandover();
    clock.advance(119);
    expect(await stateOf(app, id)).toBe("running");
    clock.advance(600);

    expect((await getJson(app, `/api/handovers/${id}`)).body).toMatchObject({
      state: "failed",
      error: "The handler stopped answering (handler lost)",
      claimedAt: "2026-11-15T10:00:00.000Z",
      finishedAt: "2026-11-15T10:02:00.000Z",
    });
    expect((await progress(app, id, claimToken)).json().state).toBe("failed");
    expect((await answer(app, id, claimToken, findings)).statusCode).toBe(409);
  });

  it("times out at its deadline, however often its lease was renewed", async () => {
    const { app, clock, id, claimToken } = await claimedHandover();
    for (let minute = 1; minute <= 9; minute++) {
      clock.advance(60);
      await progress(app, id, claimToken);
    }
    clock.advance(59);
    expect((await progress(app, id, claimToken)).json().state).toBe("running");
    clock.advance(1);

    expect((await progress(app, id, claimToken)).json().state).toBe("timed_out");
    expect((await getJson(app, `/api/handovers/${id}`)).body).toMatchObject({
      state: "timed_out",
      finishedAt: "2026-11-15T10:10:00.000Z",
    });
    expect((await answer(app, id, claimToken, findings)).statusCode).toBe(409);
  });

  it("is ended by the sweep when nobody asks", async () => {
    const { app, services, clock, id } = await claimedHandover();
    clock.advance(120);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await services.handovers.sweep();

    expect(kinds).toEqual(["handovers"]);
    expect(await stateOf(app, id)).toBe("failed");
  });

  it("survives many changes at once", async () => {
    const { app, id, claimToken } = await claimedHandover();

    const responses = await Promise.all([
      ...Array.from({ length: 5 }, (_, index) => progress(app, id, claimToken, `step ${index}`)),
      answer(app, id, claimToken, findings),
      cancel(app, id),
    ]);

    expect(responses.every((response) => response.statusCode < 500)).toBe(true);
    expect(["succeeded", "cancelled"]).toContain(await stateOf(app, id));
  });
});
