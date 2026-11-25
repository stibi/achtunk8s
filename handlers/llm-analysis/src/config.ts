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

function positive(env: Env, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number of at least 1`);
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
  return {
    server: required("ACHTUNG_URL"),
    id: env["ACHTUNG_HANDLER_ID"]?.trim() || "llm-analysis",
    token: env["ACHTUNG_HANDLER_TOKEN"]?.trim() || undefined,
    title: env["ACTION_TITLE"]?.trim() || "Explain with a Model",
    maxConcurrent: positive(env, "MAX_CONCURRENT", 4),
    model: {
      baseUrl: required("LLM_BASE_URL").replace(/\/+$/, ""),
      apiKey: env["LLM_API_KEY"]?.trim() || undefined,
      model: required("LLM_MODEL"),
      timeoutSeconds: positive(env, "LLM_TIMEOUT_SECONDS", 120),
    },
    dropLabels: names(env["DROP_LABELS"]),
    dropAnnotations: names(env["DROP_ANNOTATIONS"]),
  };
}
