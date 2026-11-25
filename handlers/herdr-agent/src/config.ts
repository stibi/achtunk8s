// The only module that reads the environment.

export interface Config {
  /** The Achtung server, and this handler on it. */
  readonly server: string;
  readonly id: string;
  readonly token: string | undefined;
  /** What the button says. */
  readonly title: string;
  /** Agents investigating at once. */
  readonly maxConcurrent: number;
  /** How long one investigation may take. */
  readonly timeoutSeconds: number;
  /**
   * Where the agents run: a directory the agent already trusts, so it starts without
   * asking. Each handover gets `handovers/<id>/` in it.
   */
  readonly workDir: string;
  /** The herdr command, and the agent it starts with which arguments. */
  readonly herdr: string;
  readonly agentKind: string;
  readonly agentArgs: readonly string[];
  /** A file of the operator's own instructions, added to the fixed ones; none when absent. */
  readonly instructionsFile: string | undefined;
  /** Whether the agent's workspace stays open after it finished, to read or go on in. */
  readonly keepWorkspace: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** The agent's arguments: a JSON array of strings, so none is split or joined by a shell. */
function argumentsFrom(text: string | undefined): string[] {
  if (text === undefined || text.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error('AGENT_ARGS must be a JSON array of strings, e.g. ["--settings","agent.json"]');
  }
  return parsed;
}

/** The configuration from the environment; throws naming what is wrong, never a value. */
export function loadConfig(env: Env = process.env): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") {
      throw new Error(`${name} is required`);
    }
    return value;
  };
  if (!/^https?:\/\//.test(required("ACHTUNG_URL"))) {
    throw new Error("ACHTUNG_URL must be an http or https URL");
  }
  if (!required("WORK_DIR").startsWith("/")) {
    throw new Error("WORK_DIR must be an absolute path");
  }
  const kind = env["AGENT_KIND"]?.trim() || "claude";
  if (!/^[a-z][a-z0-9]*$/.test(kind)) {
    throw new Error("AGENT_KIND must be one of herdr's agent kinds, e.g. claude");
  }
  return {
    server: required("ACHTUNG_URL"),
    id: env["ACHTUNG_HANDLER_ID"]?.trim() || "herdr-agent",
    token: env["ACHTUNG_HANDLER_TOKEN"]?.trim() || undefined,
    title: env["ACTION_TITLE"]?.trim() || "Investigate with Agent",
    maxConcurrent: whole(env, "MAX_CONCURRENT", 1, 1, 10),
    timeoutSeconds: whole(env, "TIMEOUT_SECONDS", 1200, 60, 3600),
    workDir: required("WORK_DIR").replace(/\/+$/, ""),
    herdr: env["HERDR_BIN"]?.trim() || "herdr",
    agentKind: kind,
    agentArgs: argumentsFrom(env["AGENT_ARGS"]),
    instructionsFile: env["INSTRUCTIONS_FILE"]?.trim() || undefined,
    keepWorkspace: (env["KEEP_WORKSPACE"]?.trim() || "true") !== "false",
  };
}
