import { describe, expect, it, onTestFinished } from "vitest";
import { handlerClient } from "../src/client.ts";
import { runHandler } from "../src/run-handler.ts";
import { fakeServer, until } from "./fake.ts";

// What the SDK does when the server refuses the handler itself.

describe("runHandler, refused for good", () => {
  const options = {
    id: "tester",
    name: "Tester",
    version: "1",
    actions: [{ id: "look", title: "Look", handle: () => Promise.reject(new Error("unused")) }],
  };

  it("rejects when its token is wrong, instead of asking again forever", async () => {
    const server = await fakeServer({ tokens: { tester: "the-right-token-0123" } });

    await expect(
      runHandler({ ...options, server: server.url, token: "a-wrong-token", onEvent: () => {} }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects when the server refuses its registration", async () => {
    const server = await fakeServer();
    const actions = [{ ...options.actions[0]!, title: "x".repeat(41) }];

    await expect(
      runHandler({ ...options, actions, server: server.url, onEvent: () => {} }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("writes errors to stderr when nobody takes the events", async () => {
    const written: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((text: string) => written.push(text) > 0) as typeof write;
    onTestFinished(() => {
      process.stderr.write = write;
    });
    const stop = new AbortController();
    const done = runHandler({
      ...options,
      server: "http://127.0.0.1:1",
      signal: stop.signal,
      stopGraceSeconds: 0,
    });

    await until(() => written.length > 0);
    stop.abort();
    await done;

    expect(written[0]).toMatch(/^achtung handler: claiming: /);
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
