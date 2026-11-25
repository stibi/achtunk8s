import { describe, expect, it } from "vitest";
import { startAlertmanagerStub } from "../alertmanager-stub.ts";
import { getJson } from "../api.ts";
import {
  cancel,
  claim,
  claimedHandover,
  handOver,
  handoverApp,
  progress,
  register,
  stateOf,
} from "../handover.ts";

// What a handler does (ADR 0022): claim its handovers, keep them alive, answer them.

describe("POST /api/handler/v0/handlers/{handler}/claim", () => {
  it("hands the handler its oldest waiting handover, with the occurrence as the API returns it", async () => {
    const { app, clock, crashLoopId, targetDownId } = await handoverApp();
    await register(app);
    await handOver(app, targetDownId);
    await handOver(app, crashLoopId);
    clock.advance(20);

    const response = await claim(app);

    expect(response.statusCode).toBe(200);
    const {
      actions: _,
      handovers: __,
      metricPanels: ___,
      ...detail
    } = (await getJson(app, `/api/occurrences/${targetDownId}`)).body;
    expect(response.json()).toEqual({
      id: 1,
      action: "investigate",
      claimToken: expect.stringMatching(/^[\w-]{43}$/),
      leaseSeconds: 120,
      deadlineAt: "2026-11-15T10:10:20.000Z",
      requestedAt: "2026-11-15T10:00:00.000Z",
      ...detail,
    });
    expect(Object.keys(response.json()).sort()).toEqual([
      "action",
      "claimToken",
      "deadlineAt",
      "events",
      "id",
      "leaseSeconds",
      "occurrence",
      "otherOccurrences",
      "requestedAt",
    ]);
    expect((await getJson(app, "/api/handovers/1")).body).toMatchObject({
      state: "running",
      claimedAt: "2026-11-15T10:00:20.000Z",
      deadlineAt: "2026-11-15T10:10:20.000Z",
    });
  });

  it("gives each handover out once, oldest first, then nothing", async () => {
    const { app, crashLoopId, targetDownId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);
    await handOver(app, targetDownId);

    const claims = [await claim(app), await claim(app), await claim(app)];

    expect(claims.map((response) => response.statusCode)).toEqual([200, 200, 204]);
    expect(claims.slice(0, 2).map((response) => response.json().id)).toEqual([1, 2]);
    expect(claims[2]?.body).toBe("");
    expect(claims[0]?.json().claimToken).not.toBe(claims[1]?.json().claimToken);
  });

  it("gives one handover to only one of several claims at once", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);

    const claims = await Promise.all(Array.from({ length: 6 }, () => claim(app)));

    expect(claims.map((response) => response.statusCode).sort()).toEqual([
      200, 204, 204, 204, 204, 204,
    ]);
  });

  it("gives a handler only its own handovers", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    await register(app, "llm");
    await handOver(app, crashLoopId, "llm");

    expect((await claim(app)).statusCode).toBe(204);
    expect((await claim(app, "llm")).statusCode).toBe(200);
  });

  it("never returns the claim token from a read", async () => {
    const { app, id, claimToken, crashLoopId } = await claimedHandover();

    const reads = await Promise.all(
      [`/api/handovers/${id}`, "/api/handovers", `/api/occurrences/${crashLoopId}`].map((url) =>
        app.inject({ method: "GET", url }),
      ),
    );

    for (const read of reads) {
      expect(read.body).not.toContain(claimToken);
      expect(read.body).not.toContain("claimToken");
    }
  });

  it("hands over nothing of the server's configuration", async () => {
    const stub = await startAlertmanagerStub();
    const endpoint = {
      url: stub.url,
      basicAuth: { username: "achtung", password: "am-s3cret" },
    };
    const { app, crashLoopId } = await handoverApp({ alertmanagers: { lab: endpoint } });
    await register(app);
    await handOver(app, crashLoopId);

    const { body } = await claim(app);

    expect(body).not.toContain("am-s3cret");
    expect(body).not.toContain(stub.url);
  });

  it("answers 404 for a handler that isn't registered", async () => {
    const { app } = await handoverApp();

    const response = await claim(app, "nobody");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Handler not registered" });
  });

  it.each(["wait=31", "wait=-1", "wait=soon"])("answers 400 for %s", async (query) => {
    const { app } = await handoverApp();
    await register(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/handler/v0/handlers/herdr-agent/claim?${query}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("says on the change stream that a handler which was away is back", async () => {
    const { app, services, clock } = await handoverApp();
    await register(app);
    clock.advance(90);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await claim(app);
    await claim(app);

    expect(kinds).toEqual(["handovers"]);
  });

  it("says on the change stream that a handover was claimed, not that nothing was", async () => {
    const { app, services, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));

    await claim(app);
    await claim(app);

    expect(kinds).toEqual(["handovers"]);
  });
});

describe("POST /api/handler/v0/handovers/{id}/progress", () => {
  it("records the message and renews the lease", async () => {
    const { app, clock, id, claimToken } = await claimedHandover();
    clock.advance(100);

    const response = await progress(app, id, claimToken, "  agent inv-1 started ");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: "running", leaseSeconds: 120 });
    clock.advance(119);
    expect((await getJson(app, `/api/handovers/${id}`)).body).toMatchObject({
      state: "running",
      progress: [{ at: "2026-11-15T10:01:40.000Z", message: "agent inv-1 started" }],
    });
  });

  it("renews the lease without a message, and records nothing", async () => {
    const { app, services, clock, id, claimToken } = await claimedHandover();
    const kinds: string[] = [];
    services.changes.subscribe((kind) => kinds.push(kind));
    clock.advance(100);

    const response = await progress(app, id, claimToken);

    expect(response.json()).toEqual({ state: "running", leaseSeconds: 120 });
    clock.advance(119);
    expect((await getJson(app, `/api/handovers/${id}`)).body).toMatchObject({
      state: "running",
      progress: [],
    });
    expect(kinds).toEqual([]);
  });

  it("keeps 200 messages; later ones only renew the lease", async () => {
    const { app, clock, id, claimToken } = await claimedHandover();
    // In batches: 200 at once would wait longer for a database connection than it allows.
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          progress(app, id, claimToken, `step ${batch * 10 + index}`),
        ),
      );
    }
    clock.advance(100);

    const response = await progress(app, id, claimToken, "one more");

    expect(response.json().state).toBe("running");
    clock.advance(119);
    const { body } = await getJson(app, `/api/handovers/${id}`);
    expect(body.state).toBe("running");
    expect(body.progress).toHaveLength(200);
    expect(body.progress.map((line: { message: string }) => line.message)).not.toContain(
      "one more",
    );
    // 200 calls, each its own transaction.
  }, 30_000);

  it("keeps the handler's actions available while it holds a running handover", async () => {
    const { app, clock, id, claimToken, targetDownId } = await claimedHandover();
    clock.advance(100);
    await progress(app, id, claimToken);
    clock.advance(100);

    const { actions } = (await getJson(app, `/api/occurrences/${targetDownId}`)).body;

    expect(actions[0].available).toBe(true);
    expect((await handOver(app, targetDownId)).statusCode).toBe(201);
  });

  it("counts as the handler being connected", async () => {
    const { app, clock, id, claimToken, targetDownId } = await claimedHandover();
    clock.advance(89);
    await progress(app, id, claimToken);
    clock.advance(89);

    expect((await handOver(app, targetDownId)).statusCode).toBe(201);
  });

  it("tells the handler that its handover was cancelled, and changes nothing", async () => {
    const { app, id, claimToken } = await claimedHandover();
    await cancel(app, id);

    const response = await progress(app, id, claimToken, "still working");

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("cancelled");
    expect((await getJson(app, `/api/handovers/${id}`)).body).toMatchObject({
      state: "cancelled",
      progress: [],
    });
  });

  it.each([
    ["without a claim token", null],
    ["with a claim token that isn't this handover's", "x".repeat(43)],
  ])("answers 403 %s and doesn't renew the lease", async (_, token) => {
    const { app, clock, id } = await claimedHandover();
    clock.advance(100);

    const response = await progress(app, id, token, "hello");

    expect(response.statusCode).toBe(403);
    clock.advance(20);
    expect(await stateOf(app, id)).toBe("failed");
  });

  it("answers 403 with another handover's claim token", async () => {
    const { app, id, targetDownId } = await claimedHandover();
    await handOver(app, targetDownId);
    const other = (await claim(app)).json();

    expect((await progress(app, id, other.claimToken)).statusCode).toBe(403);
    expect((await progress(app, other.id, other.claimToken)).statusCode).toBe(200);
  });

  it("answers 403 for a handover nobody claimed, and 404 for one that doesn't exist", async () => {
    const { app, crashLoopId } = await handoverApp();
    await register(app);
    await handOver(app, crashLoopId);

    expect((await progress(app, 1, "x".repeat(43))).statusCode).toBe(403);
    expect((await progress(app, 9, "x".repeat(43))).statusCode).toBe(404);
  });

  it.each([
    ["an empty message", ""],
    ["a message with a NUL character", "a\u0000b"],
    ["a message over 500 characters", "x".repeat(501)],
  ])("answers 400 for %s", async (_, message) => {
    const { app, id, claimToken } = await claimedHandover();

    expect((await progress(app, id, claimToken, message)).statusCode).toBe(400);
  });
});
