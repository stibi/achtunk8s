import { describe, expect, it, onTestFinished } from "vitest";
import type { HandlerClient } from "../src/client.ts";
import { handlerClient } from "../src/client.ts";
import { type Action, type HandlerEvent, HandoverStopped, runHandler } from "../src/run-handler.ts";
import { fakeServer } from "./fake.ts";

// runHandler against the fake server: the loop a plugin author doesn't write.

interface View {
  state: string;
  summary: string | null;
  body: string | null;
  error: string | null;
  links: unknown[];
  progress: { message: string }[];
}

async function running(
  action: Partial<Action> & Pick<Action, "handle">,
  client?: (real: HandlerClient) => HandlerClient,
) {
  const server = await fakeServer();
  const stop = new AbortController();
  const events: HandlerEvent[] = [];
  const options = { server: server.url, id: "tester" };
  const done = runHandler({
    ...options,
    name: "Tester",
    version: "0.1.0",
    waitSeconds: 1,
    signal: stop.signal,
    onEvent: (event) => events.push(event),
    actions: [{ id: "look", title: "Look", ...action }],
    ...(client === undefined ? {} : { client: client(handlerClient(options)) }),
  });
  onTestFinished(async () => {
    stop.abort();
    await done;
  });
  const json = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: response.status, body: (await response.json()) as View & { id: number } };
  };
  /** Hands occurrence 1 over once the handler has registered, and returns the handover's id. */
  const handOver = async () => {
    await until(() => events.some((event) => event.kind === "registered"));
    const created = await json("POST", "/api/occurrences/1/handovers", {
      handler: "tester",
      action: "look",
    });
    expect(created.status).toBe(201);
    return created.body.id;
  };
  const read = async (id: number) => (await json("GET", `/api/handovers/${id}`)).body;
  const ended = async (id: number) => {
    await until(async () => !["requested", "running"].includes((await read(id)).state));
    return read(id);
  };
  return { server, stop, done, events, handOver, read, ended, json };
}

async function until(condition: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 200; tries++) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the condition never held");
}

describe("runHandler", () => {
  it("claims a handover, runs the action and posts its result", async () => {
    const { handOver, ended, events } = await running({
      handle: async (handover, { progress }) => {
        await progress("looking\nat it");
        return {
          outcome: "succeeded",
          summary: `Saw ${handover.occurrence.title}`,
          body: "All of it.",
          links: [{ title: "Dashboard", url: "https://grafana.example.com/d/1" }],
        };
      },
    });

    const handover = await ended(await handOver());

    expect(handover).toMatchObject({
      state: "succeeded",
      summary: "Saw KubePodCrashLooping",
      body: "All of it.",
      links: [{ title: "Dashboard", url: "https://grafana.example.com/d/1" }],
      progress: [{ message: "looking at it" }],
    });
    expect(events).toContainEqual({ kind: "ended", handover: 1, outcome: "succeeded" });
  });

  it("fails the handover with the message of what the action threw", async () => {
    const { handOver, ended } = await running({
      handle: async () => {
        throw new Error("the agent wrote no findings");
      },
    });

    expect(await ended(await handOver())).toMatchObject({
      state: "failed",
      error: "the agent wrote no findings",
    });
  });

  it("fits a result to the server's limits instead of losing it", async () => {
    const { handOver, ended } = await running({
      handle: async () => ({
        outcome: "succeeded",
        summary: `first line\nsecond\u0000 line ${"x".repeat(400)}`,
        body: "y".repeat(70_000),
      }),
    });

    const handover = await ended(await handOver());

    expect(handover.state).toBe("succeeded");
    expect(handover.summary).toMatch(/^first line second line x+…$/);
    expect(handover.summary).toHaveLength(300);
    expect(handover.body).toHaveLength(65_536);
  });

  it("says why when the server refuses the result", async () => {
    const { handOver, ended } = await running({
      handle: async () => ({
        outcome: "succeeded",
        summary: "Done",
        body: "",
        links: [{ title: "Open", url: "javascript:alert(1)" }],
      }),
    });

    const handover = await ended(await handOver());

    expect(handover.state).toBe("failed");
    expect(handover.error).toContain("The server refused the handler's result");
  });

  it("tells the action to stop when the handover is cancelled, and posts nothing", async () => {
    let reason: unknown;
    const { handOver, read, json, events } = await running({
      handle: (_, { signal, progress }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            resolve({ outcome: "succeeded", summary: "Too late", body: "" });
          });
          // The next call after the cancel learns of it.
          const poll = setInterval(() => void progress("still working").catch(() => {}), 50);
          signal.addEventListener("abort", () => clearInterval(poll));
        }),
    });
    const id = await handOver();
    await until(async () => (await read(id)).state === "running");

    await json("POST", `/api/handovers/${id}/cancel`);
    await until(() => reason !== undefined);

    expect(reason).toBeInstanceOf(HandoverStopped);
    expect((reason as HandoverStopped).state).toBe("cancelled");
    await until(() => events.some((event) => event.kind === "stopped"));
    expect((await read(id)).state).toBe("cancelled");
  });

  it("works on at most maxConcurrent handovers at once, then takes the next", async () => {
    let active = 0;
    let most = 0;
    const { handOver, ended, json } = await running({
      handle: async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active -= 1;
        return { outcome: "succeeded", summary: "Done", body: "" };
      },
    });
    const first = await handOver();
    const second = (
      await json("POST", "/api/occurrences/2/handovers", { handler: "tester", action: "look" })
    ).body.id;

    await ended(first);
    await ended(second);

    expect(most).toBe(1);
  });

  it("registers again when the server forgot it", async () => {
    const { server, handOver, ended, events } = await running({
      handle: async () => ({ outcome: "succeeded", summary: "Done", body: "" }),
    });
    await until(() => events.some((event) => event.kind === "registered"));

    await fetch(`${server.url}/api/handler/v0/handlers/tester`, { method: "DELETE" });
    await until(() => events.filter((event) => event.kind === "registered").length === 2);

    expect((await ended(await handOver())).state).toBe("succeeded");
  });

  it("keeps going through an outage, reporting it", async () => {
    let failures = 2;
    const { handOver, ended, events } = await running(
      { handle: async () => ({ outcome: "succeeded", summary: "Done", body: "" }) },
      (real) => ({
        ...real,
        claim: (...args) => {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error("connect ECONNREFUSED"));
          }
          return real.claim(...args);
        },
      }),
    );

    expect((await ended(await handOver())).state).toBe("succeeded");
    expect(events.filter((event) => event.kind === "error")).toHaveLength(2);
  }, 15_000);

  it("stops when its signal aborts, telling running work to stop and failing it", async () => {
    let reason: unknown;
    const { handOver, read, stop, done } = await running({
      handle: (_, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            reject(signal.reason);
          });
        }),
    });
    const id = await handOver();
    await until(async () => (await read(id)).state === "running");

    stop.abort();
    await done;

    expect((reason as HandoverStopped).state).toBe("stopping");
    expect(await read(id)).toMatchObject({ state: "failed", error: "The handler is stopping" });
  });
});

describe("handlerClient", () => {
  it("sends the handler's token, and reports a refusal with the server's reason", async () => {
    const server = await fakeServer({ tokens: { tester: "the-right-token-0123" } });
    const registration = { name: "Tester", version: "1", actions: [{ id: "look", title: "Look" }] };
    const client = (token?: string) =>
      handlerClient({ server: `${server.url}/`, id: "tester", token });

    await expect(client("the-right-token-0123").register(registration)).resolves.toBeUndefined();
    await expect(client("a-wrong-token").register(registration)).rejects.toMatchObject({
      name: "HandlerApiError",
      status: 401,
      message: "register: 401 A handler token is required",
    });
    expect(await client("the-right-token-0123").claim(0)).toEqual({ kind: "none" });
  });

  it("says when the server doesn't know the handler", async () => {
    const server = await fakeServer();

    expect(await handlerClient({ server: server.url, id: "nobody" }).claim(0)).toEqual({
      kind: "unregistered",
    });
  });
});
