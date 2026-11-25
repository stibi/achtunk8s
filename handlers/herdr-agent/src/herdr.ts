import { execFile } from "node:child_process";

// herdr, as this handler uses it: a workspace per investigation, one agent in it. Every
// call is an argument vector; nothing goes through a shell.

/**
 * Runs herdr with `args` and returns what it printed; rejects with its error message, also
 * when it hasn't answered within `timeoutMs`.
 */
export type RunHerdr = (args: readonly string[], timeoutMs?: number) => Promise<string>;

/** How long a call to herdr may take before it counts as hung; a wait gets its own. */
const answerWithinMs = 30_000;

/** herdr's own refusal, e.g. `agent_not_ready`, with the code it gave. */
export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/** herdr's errors are JSON on stderr: `{"error": {"code", "message"}}`. */
function errorFrom(stderr: string, fallback: string): HerdrError {
  try {
    const { error } = JSON.parse(stderr) as { error?: { code?: string; message?: string } };
    if (error?.code !== undefined) {
      return new HerdrError(error.code, error.message ?? error.code);
    }
  } catch {
    // Not JSON: a crash or a usage error; its text is the message.
  }
  return new HerdrError("failed", stderr.trim() || fallback);
}

export function herdrCommand(binary: string): RunHerdr {
  return (args, timeoutMs = answerWithinMs) =>
    new Promise((resolve, reject) => {
      // A herdr that hangs would otherwise hold the investigation, and its slot, for good.
      const options = { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs };
      execFile(binary, [...args], options, (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(errorFrom(stderr, error.message));
        }
      });
    });
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Herdr {
  /** A new workspace in `cwd`, not focused. Returns its id and its first pane's. */
  createWorkspace(cwd: string, label: string): Promise<{ workspace: string; pane: string }>;
  closeWorkspace(workspace: string): Promise<void>;
  /** Starts the agent in the pane. `HerdrError("agent_not_ready")` when it asks something first. */
  startAgent(name: string, kind: string, pane: string, args: readonly string[]): Promise<void>;
  prompt(name: string, text: string): Promise<void>;
  status(name: string): Promise<AgentStatus>;
  /** Returns when the agent settles or `timeoutMs` passed, whichever is first. */
  wait(name: string, timeoutMs: number): Promise<void>;
  /** Stops what the agent is doing, as Esc does. */
  interrupt(name: string): Promise<void>;
}

const statuses: readonly string[] = ["idle", "working", "blocked", "done"];

export function herdrFor(run: RunHerdr): Herdr {
  const json = async (args: readonly string[]) =>
    JSON.parse(await run(args)) as { result?: Record<string, Record<string, unknown>> };
  return {
    createWorkspace: async (cwd, label) => {
      const { result } = await json([
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ]);
      const workspace = result?.["workspace"]?.["workspace_id"];
      const pane = result?.["root_pane"]?.["pane_id"];
      if (typeof workspace !== "string" || typeof pane !== "string") {
        throw new HerdrError("failed", "herdr created a workspace without saying which");
      }
      return { workspace, pane };
    },
    closeWorkspace: async (workspace) => {
      await run(["workspace", "close", workspace]);
    },
    startAgent: async (name, kind, pane, args) => {
      const own = args.length === 0 ? [] : ["--", ...args];
      const start = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000"];
      await run([...start, ...own], 75_000);
    },
    prompt: async (name, text) => {
      await run(["agent", "prompt", name, text]);
    },
    status: async (name) => {
      const { result } = await json(["agent", "get", name]);
      const status = result?.["agent"]?.["agent_status"];
      return typeof status === "string" && statuses.includes(status)
        ? (status as AgentStatus)
        : "unknown";
    },
    wait: async (name, timeoutMs) => {
      // Its timeout is an error to herdr and the ordinary case here.
      const wait = ["agent", "wait", name, "--timeout", String(timeoutMs)];
      await run(wait, timeoutMs + 10_000).catch(() => {});
    },
    interrupt: async (name) => {
      await run(["agent", "send-keys", name, "esc"]);
    },
  };
}
