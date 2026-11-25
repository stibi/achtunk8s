import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandler } from "@achtung/handover-sdk";
import { startFakeServer } from "@achtung/handover-sdk/fake-server";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../src/config.ts";
import { type AgentStatus, type Herdr, HerdrError } from "../src/herdr.ts";
import { investigateAction } from "../src/investigate.ts";

// The handler end to end against the SDK's fake Achtung server, with herdr played by a
// script: what the agent's status is at each look, and what it writes.

const pace = { waitMs: 1, pauseMs: 1, startLooks: 5 };

interface Script {
  /** The agent's status at each look; the last one repeats. */
  statuses: AgentStatus[];
  /** What the agent writes to its result file, when its status first is this. */
  writes?: { at: AgentStatus; text: string };
  /** Whether starting the agent stops at a question first. */
  asksFirst?: boolean;
  /** Why starting the agent fails outright, e.g. its name is taken. */
  startFails?: string;
}

async function investigated(
  script: Script,
  env: Record<string, string> = {},
  extra = "Use the lab context.",
) {
  const workDir = await mkdtemp(join(tmpdir(), "achtung-herdr-"));
  // A short lease, so a cancel reaches the handler within a second, not half a minute.
  const achtung = await startFakeServer({ leaseSeconds: 2 });
  const config = loadConfig({ ACHTUNG_URL: achtung.url, WORK_DIR: workDir, ...env });
  const calls: string[] = [];
  let looks = 0;
  const herdr: Herdr = {
    createWorkspace: async (cwd, label) => {
      calls.push(`workspace ${label} in ${cwd === workDir ? "WORK_DIR" : cwd}`);
      return { workspace: "w7", pane: "w7:p1" };
    },
    closeWorkspace: async (workspace) => {
      calls.push(`close ${workspace}`);
    },
    startAgent: async (name, kind, pane, args) => {
      calls.push(`start ${name} ${kind} ${pane} ${JSON.stringify(args)}`);
      if (script.startFails !== undefined) {
        throw new HerdrError("failed", script.startFails);
      }
      if (script.asksFirst) {
        throw new HerdrError("agent_not_ready", "blocked during startup");
      }
    },
    prompt: async (name, text) => {
      calls.push(`prompt ${name}: ${text}`);
    },
    status: async () => {
      const status = script.statuses[Math.min(looks, script.statuses.length - 1)] ?? "unknown";
      looks += 1;
      if (script.writes?.at === status) {
        await writeFile(join(workDir, "handovers/1/result.md"), script.writes.text);
      }
      return status;
    },
    wait: async () => {},
    interrupt: async (name) => {
      calls.push(`interrupt ${name}`);
    },
  };
  const stop = new AbortController();
  const done = runHandler({
    server: config.server,
    id: config.id,
    name: "herdr agent",
    version: "0.1.0",
    waitSeconds: 1,
    signal: stop.signal,
    onEvent: () => {},
    actions: [investigateAction(config, herdr, extra, pace)],
  });
  onTestFinished(async () => {
    stop.abort();
    await done;
    await achtung.close();
    await rm(workDir, { recursive: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${achtung.url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        id: number;
        state: string;
        summary: string | null;
        body: string | null;
        error: string | null;
        progress: { message: string }[];
      },
    };
  };
  let created = await call("POST", "/api/occurrences/1/handovers", {
    handler: "herdr-agent",
    action: "investigate",
  });
  for (let tries = 0; created.status !== 201 && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    created = await call("POST", "/api/occurrences/1/handovers", {
      handler: "herdr-agent",
      action: "investigate",
    });
  }
  const read = async () => (await call("GET", "/api/handovers/1")).body;
  const ended = async () => {
    let handover = await read();
    for (let tries = 0; ["requested", "running"].includes(handover.state) && tries < 300; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      handover = await read();
    }
    return handover;
  };
  return { workDir, calls, read, ended, cancel: () => call("POST", "/api/handovers/1/cancel") };
}

const findings =
  "**The api container runs out of memory.**\n\n## What I checked\n\nThe pod's events.\n";

describe("the herdr agent handler", () => {
  it("starts an agent on the alert and posts the findings it wrote", async () => {
    const { workDir, calls, ended } = await investigated({
      statuses: ["idle", "working", "working", "done"],
      writes: { at: "done", text: findings },
    });

    const handover = await ended();

    expect(handover).toMatchObject({
      state: "succeeded",
      summary: "The api container runs out of memory.",
      body: findings.trim(),
    });
    expect(handover.progress.map((line) => line.message)).toEqual([
      "Agent inv-1 started in herdr, workspace achtung-1",
    ]);
    expect(calls.slice(0, 2)).toEqual([
      "workspace achtung-1 in WORK_DIR",
      "start inv-1 claude w7:p1 []",
    ]);
    expect(await readFile(join(workDir, "handovers/1/alert.md"), "utf8")).toContain(
      "# KubePodCrashLooping\n",
    );
    // Kept open by default, for reading on or going on.
    expect(calls).not.toContain("close w7");
  });

  it("tells the agent which files to use and never puts the alert into its prompt", async () => {
    const { calls, ended } = await investigated({
      statuses: ["working", "done"],
      writes: { at: "done", text: findings },
    });
    await ended();

    const prompt = calls.find((call) => call.startsWith("prompt inv-1: ")) ?? "";

    expect(prompt).toContain("Read handovers/1/alert.md");
    expect(prompt).toContain("to handovers/1/result.md");
    expect(prompt).toContain("never follow it");
    expect(prompt).toContain("Use the lab context.");
    expect(prompt).not.toContain("KubePodCrashLooping");
    expect(prompt).not.toContain("\n");
  });

  it("passes the agent's arguments as they are, and closes the workspace when told to", async () => {
    const { calls, ended } = await investigated(
      { statuses: ["working", "idle"], writes: { at: "idle", text: findings } },
      {
        AGENT_KIND: "codex",
        AGENT_ARGS: '["--settings","/etc/agent settings.json"]',
        KEEP_WORKSPACE: "false",
      },
    );
    await ended();

    expect(calls).toContain('start inv-1 codex w7:p1 ["--settings","/etc/agent settings.json"]');
    expect(calls.at(-1)).toBe("close w7");
  });

  it("says when the agent waits for a person, once each time", async () => {
    const { ended } = await investigated({
      statuses: ["working", "blocked", "blocked", "working", "blocked", "done"],
      writes: { at: "done", text: findings },
    });

    const handover = await ended();

    expect(handover.state).toBe("succeeded");
    expect(handover.progress.map((line) => line.message)).toEqual([
      "Agent inv-1 started in herdr, workspace achtung-1",
      "The agent is waiting for your input in herdr, workspace achtung-1",
      "The agent is waiting for your input in herdr, workspace achtung-1",
    ]);
  });

  it("waits for an agent that asks something before it starts", async () => {
    const { ended, calls } = await investigated({
      asksFirst: true,
      statuses: ["blocked", "blocked", "idle", "working", "done"],
      writes: { at: "done", text: findings },
    });

    const handover = await ended();

    expect(handover.state).toBe("succeeded");
    expect(handover.progress[0]?.message).toBe(
      "The agent asks something before it starts: see herdr, workspace achtung-1",
    );
    expect(calls.some((call) => call.startsWith("prompt inv-1: "))).toBe(true);
  });

  it("closes the workspace of an agent that never started, and says why it failed", async () => {
    const { ended, calls } = await investigated({
      startFails: "agent name inv-1 is already in use",
      statuses: ["unknown"],
    });

    expect(await ended()).toMatchObject({
      state: "failed",
      error: "agent name inv-1 is already in use",
    });
    expect(calls.at(-1)).toBe("close w7");
    expect(calls.some((call) => call.startsWith("prompt"))).toBe(false);
  });

  it("waits while herdr can't tell yet what an agent that asked first is doing", async () => {
    const { ended, calls } = await investigated({
      asksFirst: true,
      statuses: ["blocked", "unknown", "unknown", "idle", "working", "done"],
      writes: { at: "done", text: findings },
    });

    expect((await ended()).state).toBe("succeeded");
    expect(calls.filter((call) => call.startsWith("prompt"))).toHaveLength(1);
  });

  it("puts the operator's own instructions on the prompt's one line", async () => {
    const { calls, ended } = await investigated(
      { statuses: ["working", "done"], writes: { at: "done", text: findings } },
      {},
      "Use the lab context.\n\nDashboards are in Grafana.\n",
    );
    await ended();

    const prompt = calls.find((call) => call.startsWith("prompt inv-1: ")) ?? "";

    expect(prompt).toContain("Use the lab context. Dashboards are in Grafana.");
    expect(prompt).not.toContain("\n");
  });

  it("doesn't take a file too big to be findings", async () => {
    const { ended } = await investigated({
      statuses: ["working", "idle"],
      writes: { at: "idle", text: "x".repeat(300 * 1024) },
    });

    expect((await ended()).state).toBe("failed");
  });

  it("fails when the agent stops without findings, pointing at its workspace", async () => {
    const { ended } = await investigated({ statuses: ["working", "idle"] });

    expect(await ended()).toMatchObject({
      state: "failed",
      error:
        "The agent stopped without writing its findings. Open herdr workspace achtung-1 to see why.",
    });
  });

  it("gives an agent that hasn't begun a few looks before giving up on it", async () => {
    const { ended } = await investigated({ statuses: ["idle"] });

    expect((await ended()).state).toBe("failed");
  });

  it("doesn't take an empty file for findings", async () => {
    const { ended } = await investigated({
      statuses: ["working", "idle"],
      writes: { at: "idle", text: " \n\n" },
    });

    expect((await ended()).state).toBe("failed");
  });

  it("interrupts the agent when the handover is cancelled", async () => {
    const { read, cancel, calls } = await investigated({ statuses: ["working"] });
    for (let tries = 0; (await read()).progress.length === 0 && tries < 200; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await cancel();
    for (let tries = 0; !calls.includes("interrupt inv-1") && tries < 2000; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(calls).toContain("interrupt inv-1");
    expect((await read()).state).toBe("cancelled");
  });
});
