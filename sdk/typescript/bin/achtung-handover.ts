#!/usr/bin/env node
import { parseArgs } from "node:util";
import { sampleOccurrences, startFakeServer } from "../src/fake-server.ts";

// `achtung-handover dev`: a fake Achtung server to try a handler against.

const usage = `Usage: achtung-handover dev [--port 8790] [--token <handler>=<token>]...

Runs a fake Achtung server with made-up alerts, for trying a handler without a real
server. It speaks the handler API and the routes that hand an alert over.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8790" },
    token: { type: "string", multiple: true, default: [] },
    help: { type: "boolean", default: false },
  },
});

if (values.help || positionals[0] !== "dev") {
  process.stdout.write(`${usage}\n`);
  process.exit(values.help ? 0 : 2);
}

const tokens = Object.fromEntries(
  values.token.map((pair) => {
    const [handler = "", ...token] = pair.split("=");
    return [handler, token.join("=")];
  }),
);
const server = await startFakeServer({
  port: Number(values.port),
  ...(values.token.length === 0 ? {} : { tokens }),
});

const alerts = sampleOccurrences
  .map((occurrence) => `  ${occurrence.id}  ${occurrence.severity.padEnd(8)} ${occurrence.title}`)
  .join("\n");
process.stdout.write(`Fake Achtung server on ${server.url}

Point your handler at it, then hand it an alert:

${alerts}

  curl -X POST ${server.url}/api/occurrences/1/handovers \\
    -H 'content-type: application/json' \\
    -d '{"handler": "<your handler id>", "action": "<your action id>"}'

  curl ${server.url}/api/handovers/1      # its state, progress and result
  curl ${server.url}/api/occurrences/1    # the actions offered and the handovers

Ctrl-C stops it.
`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close());
}
