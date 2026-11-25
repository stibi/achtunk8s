import { readFile } from "node:fs/promises";
import { runHandler } from "@achtung/handover-sdk";
import { loadConfig } from "./config.ts";
import { herdrCommand, herdrFor } from "./herdr.ts";
import { investigateAction } from "./investigate.ts";

// An Achtung handler that has a coding agent in herdr investigate an alert (ADR 0022). It
// runs next to a herdr server, on a machine that can look at what the alerts are about.
// See README.md, most of all for what the agent must not be able to do.

const config = loadConfig();
const extra =
  config.instructionsFile === undefined ? "" : await readFile(config.instructionsFile, "utf8");
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => stop.abort());
}

const log = (line: object) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);

log({ msg: "starting", server: config.server, handler: config.id, agent: config.agentKind });
await runHandler({
  server: config.server,
  id: config.id,
  token: config.token,
  name: "herdr agent",
  version: "0.1.0",
  maxConcurrent: config.maxConcurrent,
  signal: stop.signal,
  actions: [investigateAction(config, herdrFor(herdrCommand(config.herdr)), extra)],
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
