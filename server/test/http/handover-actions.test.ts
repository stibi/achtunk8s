import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { getJson } from "../api.ts";
import { agent, claim, handoverApp, register } from "../handover.ts";

// Handlers register the actions they offer; an occurrence's detail lists those that apply
// to it (ADR 0022).

async function actionsOf(app: FastifyInstance, occurrenceId: number) {
  return (await getJson(app, `/api/occurrences/${occurrenceId}`)).body.actions;
}

describe("PUT /api/handler/v0/handlers/{handler}", () => {
  it("registers the handler and answers with it, defaults filled in", async () => {
    const { app } = await handoverApp();

    const response = await register(app, "llm", {
      name: " Grok ",
      version: "1.2.0",
      actions: [{ id: "explain", title: "Explain with Grok" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "llm",
      name: "Grok",
      version: "1.2.0",
      actions: [
        {
          id: "explain",
          title: "Explain with Grok",
          description: "",
          timeoutSeconds: 900,
          appliesTo: { instances: [], severities: [], labels: {} },
        },
      ],
    });
  });

  it("offers the action on every alert, available while the handler keeps calling", async () => {
    const { app, clock, crashLoopId } = await handoverApp();
    await register(app);

    expect(await actionsOf(app, crashLoopId)).toEqual([
      {
        handler: "herdr-agent",
        handlerName: "herdr agent",
        action: "investigate",
        title: "Investigate with Agent",
        description: "Starts an agent, read-only.",
        available: true,
        lastSeenAt: "2026-11-15T10:00:00.000Z",
      },
    ]);

    clock.advance(90);
    expect((await actionsOf(app, crashLoopId))[0].available).toBe(false);

    await claim(app);
    expect((await actionsOf(app, crashLoopId))[0]).toMatchObject({
      available: true,
      lastSeenAt: "2026-11-15T10:01:30.000Z",
    });
  });

  it("offers an action only on the alerts it applies to", async () => {
    const { app, crashLoopId, targetDownId } = await handoverApp();
    await register(app, "herdr-agent", {
      ...agent,
      actions: [
        { id: "critical", title: "Critical only", appliesTo: { severities: ["critical"] } },
        { id: "lab", title: "Lab", appliesTo: { instances: ["lab"] } },
        { id: "edge", title: "Edge", appliesTo: { instances: ["edge"] } },
        { id: "crash", title: "Crash", appliesTo: { labels: { container: "api" } } },
      ],
    });

    const ids = async (occurrenceId: number) =>
      (await actionsOf(app, occurrenceId)).map((offer: { action: string }) => offer.action);
    expect(await ids(crashLoopId)).toEqual(["lab", "crash"]);
    expect(await ids(targetDownId)).toEqual(["critical", "lab"]);
  });

  it("replaces the handler's earlier registration", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);

    await register(app, "herdr-agent", {
      name: "herdr agent",
      version: "0.2.0",
      actions: [{ id: "look", title: "Look" }],
    });

    expect(await actionsOf(app, crashLoopId)).toEqual([
      expect.objectContaining({ action: "look", title: "Look" }),
    ]);
  });

  it("lists the actions of several handlers, by handler", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app, "llm", {
      name: "Grok",
      version: "1",
      actions: [{ id: "explain", title: "Explain" }],
    });
    await register(app);

    const offers = await actionsOf(app, crashLoopId);

    expect(offers.map((offer: { handler: string }) => offer.handler)).toEqual([
      "herdr-agent",
      "llm",
    ]);
  });

  it.each([
    ["no name", { ...agent, name: " " }, "name"],
    ["a name over 60 characters", { ...agent, name: "x".repeat(61) }, "name"],
    ["no version", { name: "a", actions: agent.actions }, "version"],
    ["a NUL character in the name", { ...agent, name: "a\u0000b" }, "NUL"],
    [
      "a NUL character in a label",
      { ...agent, actions: [{ id: "a", title: "A", appliesTo: { labels: { "a\u0000": "b" } } }] },
      "labels",
    ],
    ["no actions", { ...agent, actions: [] }, "actions"],
    [
      "over 10 actions",
      {
        ...agent,
        actions: Array.from({ length: 11 }, (_, index) => ({ id: `a${index}`, title: "A" })),
      },
      "actions",
    ],
    [
      "two actions with one id",
      { ...agent, actions: [...agent.actions, ...agent.actions] },
      "action ids must differ",
    ],
    ["an action id that isn't one", { ...agent, actions: [{ id: "Look!", title: "Look" }] }, "id"],
    [
      "a title over 40 characters",
      { ...agent, actions: [{ id: "a", title: "x".repeat(41) }] },
      "title",
    ],
    [
      "a timeout over an hour",
      { ...agent, actions: [{ id: "a", title: "A", timeoutSeconds: 3601 }] },
      "timeoutSeconds",
    ],
    [
      "a timeout under a minute",
      { ...agent, actions: [{ id: "a", title: "A", timeoutSeconds: 59 }] },
      "timeoutSeconds",
    ],
    [
      "a severity that isn't one",
      { ...agent, actions: [{ id: "a", title: "A", appliesTo: { severities: ["page"] } }] },
      "severities",
    ],
    [
      "an empty list of instances",
      { ...agent, actions: [{ id: "a", title: "A", appliesTo: { instances: [] } }] },
      "instances",
    ],
  ])("answers 400 for %s and registers nothing", async (_, body, field) => {
    const { app, crashLoopId } = await handoverApp();

    const response = await register(app, "herdr-agent", body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(field);
    expect(await actionsOf(app, crashLoopId)).toEqual([]);
  });

  it("answers 400 for a handler id that isn't one", async () => {
    const { app } = await handoverApp();

    expect((await register(app, "Herdr_Agent")).statusCode).toBe(400);
  });

  it("refuses the 51st handler with 409, and still takes one already registered", async () => {
    const { app } = await handoverApp();
    for (let index = 0; index < 50; index++) {
      expect((await register(app, `handler-${index}`)).statusCode).toBe(200);
    }

    const response = await register(app, "one-more");

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Too many handlers are registered" });
    expect((await register(app, "handler-7")).statusCode).toBe(200);
  });

  it("warns that a handler registered without a token", async () => {
    const logLines: Record<string, unknown>[] = [];
    const { app } = await handoverApp({ logLines });

    await register(app);

    expect(logLines).toEqual([
      expect.objectContaining({
        handler: "herdr-agent",
        msg: expect.stringContaining("HANDLER_TOKENS"),
      }),
    ]);
  });
});

describe("DELETE /api/handler/v0/handlers/{handler}", () => {
  const remove = (app: FastifyInstance, handler: string) =>
    app.inject({ method: "DELETE", url: `/api/handler/v0/handlers/${handler}` });

  it("forgets the handler, so its actions are no longer offered", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);

    const response = await remove(app, "herdr-agent");

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(await actionsOf(app, crashLoopId)).toEqual([]);
  });

  it("answers 204 for a handler it never knew", async () => {
    const { app } = await handoverApp();

    expect((await remove(app, "nobody")).statusCode).toBe(204);
  });
});

describe("the sweep", () => {
  it("forgets a handler not seen for 30 days, and says so on the change stream", async () => {
    const { app, services, clock, crashLoopId } = await handoverApp();
    await register(app);
    await register(app, "llm");
    clock.advance(29 * 24 * 3600);
    await claim(app, "llm");
    clock.advance(24 * 3600 + 1);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await services.handovers.sweep();

    expect(
      (await actionsOf(app, crashLoopId)).map((offer: { handler: string }) => offer.handler),
    ).toEqual(["llm"]);
    expect(kinds).toEqual(["handovers"]);
  });

  it("says nothing when nothing changed", async () => {
    const { app, services } = await handoverApp();
    await register(app);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await services.handovers.sweep();

    expect(kinds).toEqual([]);
  });
});
