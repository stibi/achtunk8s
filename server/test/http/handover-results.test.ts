import { describe, expect, it } from "vitest";
import { getJson } from "../api.ts";
import { answer, cancel, claimedHandover, findings, handOver, stateOf } from "../handover.ts";

// How a handler ends a handover it claimed (ADR 0022).

describe("POST /api/handler/v0/handovers/{id}/result", () => {
  it("ends the handover with the handler's findings", async () => {
    const { app, clock, id, claimToken, crashLoopId } = await claimedHandover();
    clock.advance(100);

    const response = await answer(app, id, claimToken, findings);

    expect(response.statusCode).toBe(200);
    const expected = {
      state: "succeeded",
      claimedAt: "2026-11-15T10:00:00.000Z",
      deadlineAt: null,
      finishedAt: "2026-11-15T10:01:40.000Z",
      summary: "The api container is out of memory",
      body: "## Findings\n\nThe pod was OOM-killed four times in the last hour.",
      links: [{ title: "Memory dashboard", url: "https://grafana.example.com/d/memory" }],
      error: null,
    };
    expect(response.json()).toMatchObject(expected);
    expect((await getJson(app, `/api/occurrences/${crashLoopId}`)).body.handovers[0]).toMatchObject(
      expected,
    );
  });

  it("ends the handover as failed, with the handler's reason", async () => {
    const { app, id, claimToken } = await claimedHandover();

    const response = await answer(app, id, claimToken, {
      outcome: "failed",
      error: "The agent wrote no findings",
    });

    expect(response.json()).toMatchObject({
      state: "failed",
      error: "The agent wrote no findings",
      summary: null,
      body: null,
      links: [],
    });
  });

  it("takes a result without links", async () => {
    const { app, id, claimToken } = await claimedHandover();

    const response = await answer(app, id, claimToken, {
      outcome: "succeeded",
      summary: "Nothing wrong",
      body: "",
    });

    expect(response.json()).toMatchObject({ state: "succeeded", body: "", links: [] });
  });

  it("answers the same result sent again as before, and says nothing new", async () => {
    const { app, services, clock, id, claimToken } = await claimedHandover();
    const first = await answer(app, id, claimToken, findings);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));
    clock.advance(60);

    const again = await answer(app, id, claimToken, findings);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(kinds).toEqual([]);
  });

  it("answers 409 for a different result, and keeps the first", async () => {
    const { app, id, claimToken } = await claimedHandover();
    await answer(app, id, claimToken, findings);

    const response = await answer(app, id, claimToken, { ...findings, summary: "Disk is full" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "The handover is succeeded already" });
    expect((await getJson(app, `/api/handovers/${id}`)).body.summary).toBe(findings.summary);
  });

  it("answers 409 for a handover cancelled in the meantime", async () => {
    const { app, id, claimToken } = await claimedHandover();
    await cancel(app, id);

    const response = await answer(app, id, claimToken, findings);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "The handover is cancelled already" });
    expect(await stateOf(app, id)).toBe("cancelled");
  });

  it("frees the occurrence for another handover of the action", async () => {
    const { app, id, claimToken, crashLoopId } = await claimedHandover();
    await answer(app, id, claimToken, findings);

    const next = await handOver(app, crashLoopId);

    expect(next.statusCode).toBe(201);
    expect(next.json().id).toBe(id + 1);
  });

  it("answers 403 without this handover's claim token, and 404 for none", async () => {
    const { app, id } = await claimedHandover();

    expect((await answer(app, id, "x".repeat(43), findings)).statusCode).toBe(403);
    expect((await answer(app, 9, "x".repeat(43), findings)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/handler/v0/handovers/${id}/result`,
          body: findings,
        })
      ).statusCode,
    ).toBe(403);
    expect(await stateOf(app, id)).toBe("running");
  });

  it.each([
    ["no outcome", { summary: "x", body: "y" }, "outcome"],
    ["an outcome that isn't one", { ...findings, outcome: "done" }, "outcome"],
    ["no summary", { ...findings, summary: " " }, "summary"],
    ["a summary over 300 characters", { ...findings, summary: "x".repeat(301) }, "summary"],
    ["a body over 64 KiB", { ...findings, body: "x".repeat(65_537) }, "body"],
    [
      "over 10 links",
      { ...findings, links: Array.from({ length: 11 }, () => findings.links[0]) },
      "links",
    ],
    [
      "a link that isn't http or https",
      { ...findings, links: [{ title: "Open", url: "javascript:alert(1)" }] },
      "an http or https URL",
    ],
    [
      "a link with a custom scheme",
      { ...findings, links: [{ title: "Open", url: "rex://session/1" }] },
      "an http or https URL",
    ],
    [
      "a link with credentials",
      { ...findings, links: [{ title: "Open", url: "https://user:pw@grafana.example.com/" }] },
      "without credentials",
    ],
    ["a summary of two lines", { ...findings, summary: "two\nlines" }, "one line"],
    ["a NUL character in the body", { ...findings, body: "a\u0000b" }, "NUL"],
    ["a broken surrogate pair in the summary", { ...findings, summary: "a\ud800b" }, "broken"],
    [
      "a NUL character in a link's title",
      { ...findings, links: [{ title: "a\u0000", url: "https://a.example" }] },
      "NUL",
    ],
    ["a NUL character in a failure", { outcome: "failed", error: "a\u0000b" }, "NUL"],
    [
      "a link that isn't a URL",
      { ...findings, links: [{ title: "Open", url: "grafana" }] },
      "an http or https URL",
    ],
    [
      "a link without a title",
      { ...findings, links: [{ title: "", url: "https://a.example" }] },
      "title",
    ],
    ["a failure without a reason", { outcome: "failed", error: "" }, "error"],
    ["a failure over 2000 characters", { outcome: "failed", error: "x".repeat(2001) }, "error"],
  ])("answers 400 for %s and leaves the handover running", async (_, body, field) => {
    const { app, id, claimToken } = await claimedHandover();

    const response = await answer(app, id, claimToken, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(field);
    expect(await stateOf(app, id)).toBe("running");
  });

  it("stores a link as its URL parses, not as it was written", async () => {
    const { app, id, claimToken } = await claimedHandover();

    const response = await answer(app, id, claimToken, {
      ...findings,
      links: [{ title: "Dashboard", url: " HTTPS://Grafana.example.com/d/a b\t" }],
    });

    expect(response.json().links).toEqual([
      { title: "Dashboard", url: "https://grafana.example.com/d/a%20b" },
    ]);
  });

  it("takes a body of exactly 64 KiB", async () => {
    const { app, id, claimToken } = await claimedHandover();

    const response = await answer(app, id, claimToken, { ...findings, body: "x".repeat(65_536) });

    expect(response.statusCode).toBe(200);
  });
});
