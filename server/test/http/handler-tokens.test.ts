import { describe, expect, it } from "vitest";
import { getJson } from "../api.ts";
import {
  agent,
  answer,
  cancel,
  claim,
  findings,
  handOver,
  handoverApp,
  progress,
  register,
} from "../handover.ts";

// With handler tokens configured, the handler API takes a handler's bearer token (ADR 0023).

const agentToken = "agent-token-0123456789";
const llmToken = "llm-token-0123456789";
const tokens = new Map([
  ["herdr-agent", agentToken],
  ["llm", llmToken],
]);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const withTokens = (logLines: Record<string, unknown>[] = []) =>
  handoverApp({ handlers: { tokens }, logLines });

describe("the handler API with tokens", () => {
  it("lets a handler register, claim and answer with its own token", async () => {
    const logLines: Record<string, unknown>[] = [];
    const { app, crashLoopId } = await withTokens(logLines);

    expect((await register(app, "herdr-agent", agent, bearer(agentToken))).statusCode).toBe(200);
    await handOver(app, crashLoopId);
    const claimed = await claim(app, "herdr-agent", bearer(agentToken));
    expect(claimed.statusCode).toBe(200);
    const { id, claimToken } = claimed.json();
    expect((await progress(app, id, claimToken, "started", bearer(agentToken))).statusCode).toBe(
      200,
    );
    const result = await app.inject({
      method: "POST",
      url: `/api/handler/v0/handovers/${id}/result`,
      headers: { ...bearer(agentToken), "achtung-claim": claimToken },
      body: findings,
    });
    expect(result.statusCode).toBe(200);
    expect(logLines).toEqual([]);
  });

  it.each([
    ["no token", {}],
    ["a token no handler has", bearer("some-other-token-0123")],
    ["a token that isn't a bearer token", { authorization: agentToken }],
    ["basic credentials", { authorization: `Basic ${agentToken}` }],
    ["an empty bearer token", { authorization: "Bearer " }],
  ])("answers 401 for %s, on every handler route", async (_, headers) => {
    const { app } = await withTokens();
    const call = (method: "PUT" | "POST" | "DELETE", path: string) =>
      app.inject({ method, url: `/api/handler/v0/${path}`, headers, body: agent });

    const responses = await Promise.all([
      call("PUT", "handlers/herdr-agent"),
      call("DELETE", "handlers/herdr-agent"),
      call("POST", "handlers/herdr-agent/claim?wait=0"),
      call("POST", "handovers/1/progress"),
      call("POST", "handovers/1/result"),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(responses[0]?.json()).toEqual({ error: "A handler token is required" });
    expect(responses[0]?.headers["www-authenticate"]).toBe("Bearer");
  });

  it("answers 403 for another handler's token", async () => {
    const { app, crashLoopId } = await withTokens();
    await register(app, "herdr-agent", agent, bearer(agentToken));

    const asAgent = await Promise.all([
      register(app, "herdr-agent", agent, bearer(llmToken)),
      claim(app, "herdr-agent", bearer(llmToken)),
      app.inject({
        method: "DELETE",
        url: "/api/handler/v0/handlers/herdr-agent",
        headers: bearer(llmToken),
      }),
    ]);

    expect(asAgent.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(asAgent[0]?.json()).toEqual({ error: "The token belongs to another handler" });
    expect((await getJson(app, `/api/occurrences/${crashLoopId}`)).body.actions).toHaveLength(1);
  });

  it("refuses a handler that has no token, even with a valid one", async () => {
    const { app } = await withTokens();

    expect((await register(app, "newcomer", agent, bearer(agentToken))).statusCode).toBe(403);
  });

  it("lets only the claiming handler report on a handover, even with its claim token", async () => {
    const { app, crashLoopId } = await withTokens();
    await register(app, "herdr-agent", agent, bearer(agentToken));
    await handOver(app, crashLoopId);
    const { id, claimToken } = (await claim(app, "herdr-agent", bearer(agentToken))).json();

    const response = await progress(app, id, claimToken, "mine now", bearer(llmToken));

    expect(response.statusCode).toBe(403);
    expect((await getJson(app, `/api/handovers/${id}`)).body.progress).toEqual([]);
  });

  it("never logs or answers with a token", async () => {
    const logLines: Record<string, unknown>[] = [];
    const { app } = await withTokens(logLines);

    const responses = [
      await register(app, "herdr-agent", agent, bearer(llmToken)),
      await register(app, "herdr-agent", agent, bearer("wrong-token-0123456789")),
    ];

    const said = JSON.stringify(logLines) + responses.map((response) => response.body).join();
    expect(said).not.toContain(agentToken);
    expect(said).not.toContain(llmToken);
    expect(said).not.toContain("wrong-token");
  });

  it("leaves the client's routes open", async () => {
    const { app, crashLoopId } = await withTokens();
    await register(app, "herdr-agent", agent, bearer(agentToken));

    expect((await handOver(app, crashLoopId)).statusCode).toBe(201);
    expect((await getJson(app, "/api/handovers")).status).toBe(200);
    expect((await cancel(app, 1)).statusCode).toBe(200);
  });
});

describe("the handler API without tokens", () => {
  it("ignores a bearer token", async () => {
    const { app, crashLoopId } = await handoverApp();

    expect((await register(app, "herdr-agent", agent, bearer("whatever"))).statusCode).toBe(200);
    await handOver(app, crashLoopId);
    const { id, claimToken } = (await claim(app)).json();
    expect((await answer(app, id, claimToken, findings)).statusCode).toBe(200);
  });
});
