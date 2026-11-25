import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { HerdrError, herdrFor } from "../src/herdr.ts";

const env = { ACHTUNG_URL: "http://achtung.example", WORK_DIR: "/srv/achtung-agent/" };

describe("loadConfig", () => {
  it("has defaults for everything but the server and the directory", () => {
    expect(loadConfig(env)).toEqual({
      server: "http://achtung.example",
      id: "herdr-agent",
      token: undefined,
      title: "Investigate with Agent",
      maxConcurrent: 1,
      timeoutSeconds: 1200,
      workDir: "/srv/achtung-agent",
      herdr: "herdr",
      agentKind: "claude",
      agentArgs: [],
      instructionsFile: undefined,
      keepWorkspace: true,
    });
  });

  it.each([
    ["no directory", { ...env, WORK_DIR: undefined }, "WORK_DIR is required"],
    ["a relative directory", { ...env, WORK_DIR: "agent" }, "WORK_DIR must be an absolute path"],
    [
      "arguments that aren't a JSON array",
      { ...env, AGENT_ARGS: "--settings x" },
      "AGENT_ARGS must be",
    ],
    ["an argument that isn't a string", { ...env, AGENT_ARGS: "[1]" }, "AGENT_ARGS must be"],
    ["an agent kind with a space", { ...env, AGENT_KIND: "claude --x" }, "AGENT_KIND must be"],
    ["a timeout over an hour", { ...env, TIMEOUT_SECONDS: "3601" }, "TIMEOUT_SECONDS must be"],
    ["no concurrency", { ...env, MAX_CONCURRENT: "0" }, "MAX_CONCURRENT must be"],
    [
      "a title over 40 characters",
      { ...env, ACTION_TITLE: "x".repeat(41) },
      "ACTION_TITLE must be",
    ],
    ["a handler id that isn't one", { ...env, ACHTUNG_HANDLER_ID: "Herdr" }, "ACHTUNG_HANDLER_ID"],
    ["a token over two lines", { ...env, ACHTUNG_HANDLER_TOKEN: "a\nb" }, "ACHTUNG_HANDLER_TOKEN"],
  ])("refuses %s, naming the variable", (_, values, message) => {
    expect(() => loadConfig(values)).toThrow(message);
  });
});

describe("herdrFor", () => {
  it("calls herdr with argument vectors and reads its JSON", async () => {
    const calls: string[][] = [];
    const herdr = herdrFor(async (args) => {
      calls.push([...args]);
      return JSON.stringify({
        result: {
          workspace: { workspace_id: "w7" },
          root_pane: { pane_id: "w7:p1" },
          agent: { agent_status: "working" },
        },
      });
    });

    expect(await herdr.createWorkspace("/srv/a b", "achtung-1")).toEqual({
      workspace: "w7",
      pane: "w7:p1",
    });
    await herdr.startAgent("inv-1", "claude", "w7:p1", ["--settings", "a b.json"]);
    await herdr.startAgent("inv-2", "claude", "w7:p1", []);
    await herdr.prompt("inv-1", "Read the file; then $(stop).");
    expect(await herdr.status("inv-1")).toBe("working");

    expect(calls).toEqual([
      ["workspace", "create", "--cwd", "/srv/a b", "--label", "achtung-1", "--no-focus"],
      [
        "agent",
        "start",
        "inv-1",
        "--kind",
        "claude",
        "--pane",
        "w7:p1",
        "--timeout",
        "60000",
        "--",
        "--settings",
        "a b.json",
      ],
      ["agent", "start", "inv-2", "--kind", "claude", "--pane", "w7:p1", "--timeout", "60000"],
      ["agent", "prompt", "inv-1", "Read the file; then $(stop)."],
      ["agent", "get", "inv-1"],
    ]);
  });

  it("takes a status it doesn't know for unknown, and a timed-out wait for nothing", async () => {
    const herdr = herdrFor(async (args) => {
      if (args[1] === "wait") {
        throw new HerdrError("timeout", "timed out");
      }
      return JSON.stringify({ result: { agent: { agent_status: "napping" } } });
    });

    expect(await herdr.status("inv-1")).toBe("unknown");
    await expect(herdr.wait("inv-1", 10)).resolves.toBeUndefined();
  });

  it("fails when herdr doesn't say which workspace it made", async () => {
    const herdr = herdrFor(async () => JSON.stringify({ result: {} }));

    await expect(herdr.createWorkspace("/srv/a", "x")).rejects.toThrow(/without saying which/);
  });
});
