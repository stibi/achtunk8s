import { runHandler } from "@achtung/handover-sdk";
import { loadConfig } from "./config.ts";
import { explainAction } from "./handler.ts";

// An Achtung handler that asks a language model what an alert means (ADR 0022). It runs
// anywhere that reaches the Achtung server and the model's API. See README.md.

const config = loadConfig();
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => stop.abort());
}

const log = (line: object) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);

log({ msg: "starting", server: config.server, handler: config.id, model: config.model.model });
await runHandler({
  server: config.server,
  id: config.id,
  token: config.token,
  name: "LLM analysis",
  version: "0.1.0",
  maxConcurrent: config.maxConcurrent,
  signal: stop.signal,
  actions: [explainAction(config)],
  onEvent: (event) =>
    log(
      event.kind === "error"
        ? {
            ...event,
            error: event.error instanceof Error ? event.error.message : String(event.error),
          }
        : event,
    ),
});
log({ msg: "stopped" });
