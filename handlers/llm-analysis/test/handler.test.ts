import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runHandler } from "@achtung/handover-sdk";
import { startFakeServer } from "@achtung/handover-sdk/fake-server";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../src/config.ts";
import { explainAction } from "../src/handler.ts";

// The handler end to end: a fake Achtung server, and a fake model API that records what
// it was asked.

/** A handover as the fake Achtung shows it. */
interface View {
  id: number;
  state: string;
  title: string;
  summary: string | null;
  body: string;
  error: string | null;
}

interface Asked {
  authorization: string | undefined;
  body: { model: string; messages: { role: string; content: string }[] };
}

async function fakeModel(reply: (asked: Asked) => { status: number; body: unknown }) {
  const asked: Asked[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) {
      text += chunk;
    }
    const call = { authorization: request.headers.authorization, body: JSON.parse(text) };
    asked.push(call);
    const { status, body } = reply(call);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, asked };
}

const answer = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { role: "assistant", content } }] },
});

async function explained(reply: Parameters<typeof fakeModel>[0], env: Record<string, string> = {}) {
  const model = await fakeModel(reply);
  const achtung = await startFakeServer();
  const config = loadConfig({
    ACHTUNG_URL: achtung.url,
    LLM_BASE_URL: model.url,
    LLM_MODEL: "example-model",
    ...env,
  });
  const stop = new AbortController();
  const done = runHandler({
    server: config.server,
    id: config.id,
    name: "LLM analysis",
    version: "0.1.0",
    waitSeconds: 1,
    signal: stop.signal,
    onEvent: () => {},
    actions: [explainAction(config)],
  });
  onTestFinished(async () => {
    stop.abort();
    await done;
    await achtung.close();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${achtung.url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: response.status, body: (await response.json()) as View };
  };
  let created = { status: 409, body: {} as View };
  for (let tries = 0; created.status !== 201 && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    created = await call("POST", "/api/occurrences/1/handovers", {
      handler: "llm-analysis",
      action: "explain",
    });
  }
  let handover = (await call("GET", `/api/handovers/${created.body.id}`)).body;
  for (let tries = 0; ["requested", "running"].includes(handover.state) && tries < 200; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    handover = (await call("GET", `/api/handovers/${created.body.id}`)).body;
  }
  return { handover, asked: model.asked };
}

describe("the model handler", () => {
  it("asks the model about the alert and answers with what it said", async () => {
    const { handover, asked } = await explained(() =>
      answer("**The pod is crash looping.**\n\n## What it means\n\nIt restarts."),
    );

    expect(handover).toMatchObject({
      state: "succeeded",
      summary: "The pod is crash looping.",
      title: "Explain with a Model",
    });
    expect(handover.body).toContain("## What it means\n\nIt restarts.");
    expect(handover.body).toContain("_From example-model, which read the alert and nothing else._");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBeUndefined();
    expect(asked[0]?.body.model).toBe("example-model");
    expect(asked[0]?.body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    const user = asked[0]?.body.messages[1]?.content ?? "";
    expect(user).toMatch(/^BEGIN (ALERT-[0-9a-f]{16})\n# KubePodCrashLooping\n[\s\S]*\nEND \1$/);
    expect(asked[0]?.body.messages[0]?.content).toContain(user.slice(6, 28));
    expect(user).toContain("pod=api-7c9d8b6f5-x2k4q");
  });

  it("sends its API key, and leaves out the labels and annotations it is told to drop", async () => {
    const { asked } = await explained(() => answer("Fine."), {
      LLM_API_KEY: "an-example-key",
      DROP_LABELS: "pod, namespace",
      DROP_ANNOTATIONS: "summary",
      ACTION_TITLE: "Explain with Grok",
    });

    const user = asked[0]?.body.messages[1]?.content ?? "";
    expect(asked[0]?.authorization).toBe("Bearer an-example-key");
    expect(user).not.toContain("api-7c9d8b6f5-x2k4q");
    expect(user).not.toContain("namespace=");
    expect(user).not.toContain("KubePodCrashLooping in example-prod");
    expect(user).toContain("alertname=KubePodCrashLooping");
  });

  it("fails the handover when the model's API refuses, without repeating its answer", async () => {
    const { handover } = await explained(() => ({
      status: 401,
      body: { error: "bad key an-example-key" },
    }));

    expect(handover).toMatchObject({ state: "failed", error: "The model's API answered 401" });
  });

  it("copes with an answer that isn't JSON, is a list of parts, or thinks aloud first", async () => {
    const html = await explained(() => ({ status: 200, body: "<html>s3cret</html>" }));
    const parts = await explained(() => ({
      status: 200,
      body: { choices: [{ message: { content: [{ type: "text", text: "Disk is full." }] } }] },
    }));
    const thinking = await explained(() =>
      answer("<think>hmm, the pod…</think>\n\nThe pod is down."),
    );

    expect(html.handover.error).toBe("The model's API answered without any text");
    expect(parts.handover.summary).toBe("Disk is full.");
    expect(thinking.handover.summary).toBe("The pod is down.");
    expect(thinking.handover.body).not.toContain("hmm");
  });

  it("fails the handover when the model says nothing", async () => {
    const { handover } = await explained(() => answer("  "));

    expect(handover).toMatchObject({
      state: "failed",
      error: "The model's API answered without any text",
    });
  });
});
