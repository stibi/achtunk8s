import { describe, expect, it } from "vitest";
import { getJson } from "../api.ts";
import {
  agent,
  answer,
  cancel,
  claim,
  claimedHandover,
  findings,
  handOver,
  handoverApp,
  register,
  stateOf,
} from "../handover.ts";

// What a client does with handovers (ADR 0022): ask for one, cancel it, read them.

describe("POST /api/occurrences/{id}/handovers", () => {
  it("asks the handler, and shows the handover in the occurrence's detail", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);

    const response = await handOver(app, crashLoopId);

    expect(response.statusCode).toBe(201);
    const handover = {
      id: 1,
      occurrenceId: crashLoopId,
      handler: "herdr-agent",
      handlerName: "herdr agent",
      handlerVersion: "0.1.0",
      action: "investigate",
      title: "Investigate with Agent",
      state: "requested",
      requestedAt: "2026-11-15T10:00:00.000Z",
      claimedAt: null,
      deadlineAt: null,
      finishedAt: null,
      summary: null,
      body: null,
      links: [],
      error: null,
      progress: [],
    };
    expect(response.json()).toEqual(handover);
    expect((await getJson(app, `/api/occurrences/${crashLoopId}`)).body.handovers).toEqual([
      handover,
    ]);
    expect((await getJson(app, "/api/handovers/1")).body).toEqual(handover);
  });

  it("answers with the one already requested or running, and makes nothing new", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);

    const again = await handOver(app, crashLoopId);
    await claim(app);
    const whileRunning = await handOver(app, crashLoopId);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: 1, state: "requested" });
    expect(whileRunning.statusCode).toBe(200);
    expect(whileRunning.json()).toMatchObject({ id: 1, state: "running" });
    expect((await getJson(app, "/api/handovers")).body.handovers).toHaveLength(1);
  });

  it("makes a new one once the earlier one ended, and for another alert or action", async () => {
    const { app, crashLoopId, targetDownId } = await handoverApp();
    await register(app, "herdr-agent", {
      ...agent,
      actions: [...agent.actions, { id: "explain", title: "Explain" }],
    });
    await handOver(app, crashLoopId);
    await cancel(app, 1);

    const afterCancel = await handOver(app, crashLoopId);
    const otherAlert = await handOver(app, targetDownId);
    const otherAction = await handOver(app, crashLoopId, "herdr-agent", "explain");

    expect([afterCancel, otherAlert, otherAction].map((response) => response.statusCode)).toEqual([
      201, 201, 201,
    ]);
    expect([afterCancel, otherAlert, otherAction].map((response) => response.json().id)).toEqual([
      2, 3, 4,
    ]);
  });

  it("keeps the handler's name and the action's title as they were when asked", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);

    await app.inject({ method: "DELETE", url: "/api/handler/v0/handlers/herdr-agent" });

    expect((await getJson(app, "/api/handovers/1")).body).toMatchObject({
      handlerName: "herdr agent",
      handlerVersion: "0.1.0",
      title: "Investigate with Agent",
    });
  });

  it("answers 404 for an occurrence that doesn't exist", async () => {
    const { app } = await handoverApp();
    await register(app);

    const response = await handOver(app, 999);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Occurrence not found" });
  });

  it.each([
    ["a handler nobody registered", "nobody", "investigate", "No handler offers this action"],
    [
      "an action the handler doesn't offer",
      "herdr-agent",
      "explain",
      "No handler offers this action",
    ],
    [
      "an action that isn't for this alert",
      "herdr-agent",
      "critical-only",
      "This action isn't offered for this alert",
    ],
  ])("answers 409 for %s", async (_, handler, action, error) => {
    const { app, crashLoopId } = await handoverApp();
    await register(app, "herdr-agent", {
      ...agent,
      actions: [
        ...agent.actions,
        { id: "critical-only", title: "Critical", appliesTo: { severities: ["critical"] } },
      ],
    });

    const response = await handOver(app, crashLoopId, handler, action);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error });
  });

  it("answers 409 when the handler isn't connected, and takes it once it calls again", async () => {
    const { app, clock, crashLoopId } = await handoverApp();
    await register(app);
    clock.advance(90);

    const response = await handOver(app, crashLoopId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "herdr agent isn't connected" });
    await claim(app);
    expect((await handOver(app, crashLoopId)).statusCode).toBe(201);
  });

  it.each([
    ["no action", { handler: "herdr-agent" }],
    ["a handler id that isn't one", { handler: "Herdr Agent", action: "investigate" }],
  ])("answers 400 for %s", async (_, body) => {
    const { app, crashLoopId } = await handoverApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/occurrences/${crashLoopId}/handovers`,
      body,
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses the 21st active handover with 503, until one ends", async () => {
    const { app, crashLoopId } = await handoverApp();
    const actions = Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, title: "A" }));
    await register(app, "one", { ...agent, actions });
    await register(app, "two", { ...agent, actions });
    await register(app, "three", agent);
    for (const handler of ["one", "two"]) {
      for (const { id } of actions) {
        expect((await handOver(app, crashLoopId, handler, id)).statusCode).toBe(201);
      }
    }

    const response = await handOver(app, crashLoopId, "three");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Too many handovers are requested or running" });
    await cancel(app, 1);
    expect((await handOver(app, crashLoopId, "three")).statusCode).toBe(201);
  });

  it("says on the change stream that handovers changed", async () => {
    const { app, services, crashLoopId } = await handoverApp();
    await register(app);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await handOver(app, crashLoopId);
    await handOver(app, crashLoopId);
    await cancel(app, 1);
    await cancel(app, 1);

    expect(kinds).toEqual(["handovers", "handovers"]);
  });
});

describe("a handover nobody claims", () => {
  it("expires after 10 minutes, at that moment, whoever looks first", async () => {
    const { app, clock, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);

    clock.advance(599);
    expect(await stateOf(app, 1)).toBe("requested");
    clock.advance(3600);

    expect((await getJson(app, "/api/handovers/1")).body).toMatchObject({
      state: "expired",
      finishedAt: "2026-11-15T10:10:00.000Z",
      claimedAt: null,
    });
  });

  it("can't be claimed once it is expired, and doesn't block a new one", async () => {
    const { app, clock, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);
    clock.advance(600);

    expect((await claim(app)).statusCode).toBe(204);
    const again = await handOver(app, crashLoopId);

    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(2);
    expect(await stateOf(app, 1)).toBe("expired");
  });

  it("is recorded by the sweep, which says so on the change stream", async () => {
    const { app, services, clock, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);
    clock.advance(600);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await services.handovers.sweep();
    await services.handovers.sweep();

    expect(kinds).toEqual(["handovers"]);
  });
});

describe("POST /api/handovers/{id}/cancel", () => {
  it("cancels a requested handover at once", async () => {
    const { app, clock, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);
    clock.advance(30);

    const response = await cancel(app, 1);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "cancelled",
      claimedAt: null,
      finishedAt: "2026-11-15T10:00:30.000Z",
    });
    expect((await claim(app)).statusCode).toBe(204);
  });

  it("cancels a running handover, keeping when it was claimed", async () => {
    const { app, clock, id } = await claimedHandover();
    clock.advance(45);

    const response = await cancel(app, id);

    expect(response.json()).toMatchObject({
      state: "cancelled",
      claimedAt: "2026-11-15T10:00:00.000Z",
      deadlineAt: null,
      finishedAt: "2026-11-15T10:00:45.000Z",
    });
  });

  it("answers 409 for one that ended, and leaves it as it ended", async () => {
    const { app, id, claimToken } = await claimedHandover();
    await answer(app, id, claimToken, findings);

    const response = await cancel(app, id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "The handover is succeeded already" });
    expect(await stateOf(app, id)).toBe("succeeded");
  });

  it("answers 404 for one that doesn't exist", async () => {
    const { app } = await handoverApp();

    const response = await cancel(app, 7);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Handover not found" });
  });
});
