// The only module that reads the environment.

export interface Config {
  /** The Achtung server, and this handler on it. */
  readonly server: string;
  readonly id: string;
  readonly token: string | undefined;
  /** What the button says. */
  readonly title: string;
  /** Handovers answered at once. */
  readonly maxConcurrent: number;
  readonly model: ModelConfig;
  /** Labels and annotations never sent to the model, by name. */
  readonly dropLabels: readonly string[];
  readonly dropAnnotations: readonly string[];
}

export interface ModelConfig {
  /** An OpenAI-compatible API, e.g. https://api.x.ai/v1 or http://127.0.0.1:11434/v1. */
  readonly baseUrl: string;
  /** Left out for a local model that needs none. */
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutSeconds: number;
}

const names = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

function whole(env: Env, name: string, fallback: number, max: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  }
  return value;
}

/** A secret from the environment; refused, unquoted, when it couldn't go into a header. */
function secret(env: Env, name: string): string | undefined {
  const value = env[name]?.trim() || undefined;
  if (value !== undefined && /[^\x21-\x7e]/.test(value)) {
    throw new Error(`${name} must be one line of printable characters without spaces`);
  }
  return value;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The configuration from the environment; throws naming what is missing, never a value. */
export function loadConfig(env: Env = process.env): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") {
      throw new Error(`${name} is required`);
    }
    return value;
  };
  for (const name of ["ACHTUNG_URL", "LLM_BASE_URL"]) {
    if (!/^https?:\/\//.test(required(name))) {
      throw new Error(`${name} must be an http or https URL`);
    }
  }
  const id = env["ACHTUNG_HANDLER_ID"]?.trim() || "llm-analysis";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error("ACHTUNG_HANDLER_ID must be lowercase letters, digits and dashes");
  }
  const title = env["ACTION_TITLE"]?.trim() || "Explain with a Model";
  if (title.length > 40) {
    throw new Error("ACTION_TITLE must be at most 40 characters");
  }
  return {
    server: required("ACHTUNG_URL"),
    id,
    token: secret(env, "ACHTUNG_HANDLER_TOKEN"),
    title,
    maxConcurrent: whole(env, "MAX_CONCURRENT", 4, 20),
    model: {
      baseUrl: required("LLM_BASE_URL").replace(/\/+$/, ""),
      apiKey: secret(env, "LLM_API_KEY"),
      model: required("LLM_MODEL"),
      // The action's timeout is this plus a margin, and the server allows an hour.
      timeoutSeconds: whole(env, "LLM_TIMEOUT_SECONDS", 120, 3500),
    },
    dropLabels: names(env["DROP_LABELS"]),
    dropAnnotations: names(env["DROP_ANNOTATIONS"]),
  };
}
