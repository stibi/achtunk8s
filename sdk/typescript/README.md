# Achtung handover SDK (TypeScript)

Write a plugin for [Achtung](../../README.md): a **handler**, a program of yours that
takes alerts handed over to it, does something with them (asks an agent to investigate,
asks a model to explain, opens a ticket) and reports back into the alert.

A handler connects out to the Achtung server; nothing is installed into Achtung. The
protocol is plain HTTP and is described in
[`docs/handover-protocol.md`](../../docs/handover-protocol.md), with a handler in `curl`.
This SDK is the same protocol with the loop written for you.

**Status: `0.x`, for protocol `v0`.** Both may still change. The package isn't published
yet; use it from this repository's workspace.

## A handler in a few lines

```ts
import { agentReport, runHandler } from "@achtung/handover-sdk";

await runHandler({
  server: "http://127.0.0.1:8790",
  id: "echo",
  name: "Echo",
  version: "0.1.0",
  token: process.env.ACHTUNG_HANDLER_TOKEN, // when the server sets HANDLER_TOKENS
  actions: [
    {
      id: "echo",
      title: "Echo the Alert",
      description: "Sends the alert back as it would be put into a prompt.",
      timeoutSeconds: 120,
      async handle(handover, { progress, signal }) {
        await progress("reading the alert");
        signal.throwIfAborted(); // cancelled, timed out, or the handler is stopping
        return {
          outcome: "succeeded",
          summary: `Saw ${handover.occurrence.title}`,
          body: agentReport(handover),
          links: [],
        };
      },
    },
  ],
});
```

`runHandler` registers the actions, claims handovers in a loop, keeps each one's lease
alive while `handle` works, and posts what it returns. It runs until its `signal` aborts.

- **`handle(handover, context)`** gets the handover with the occurrence, its events and
  the alert's other occurrences. Return `{ outcome: "succeeded", summary, body, links }`
  or `{ outcome: "failed", error }`; throwing fails the handover with the error's message.
- **`context.progress(message)`** shows a status line to the person waiting.
- **`context.signal`** aborts when the work should stop. Its `reason` is a
  `HandoverStopped` whose `state` says why: `cancelled`, `timed_out`, `failed` (the lease
  was lost) or `stopping` (the handler itself is shutting down).
- **`maxConcurrent`** (default 1) is how many handovers run at once. The rest wait on the
  server, for up to ten minutes.
- **`appliesTo`** on an action limits it to some alerts: `instances`, `severities`,
  `labels` (exact), all of which must match.
- **`onEvent`** reports what the loop does (registered, claimed, ended, stopped, error),
  for your logs. Without it, errors are written to stderr. Outages of the server are
  retried with a growing pause, also for a result, which isn't lost to one. A refusal that
  asking again won't change (a wrong token, an invalid registration) rejects out of
  `runHandler`.
- **`signal`** stops the handler. Running work is told to stop and gets
  `stopGraceSeconds` (10) to do so; work that ignores its signal is left behind, and its
  handover fails on the server as "handler lost".
- A result is fitted to the server's limits rather than lost: a summary becomes one line
  of at most 300 characters, a body is cut at 64 KiB, NUL characters go.

`agentReport(handover)` is the alert as Markdown for a prompt, the same text as the
macOS app's Copy for Agent. `handlerClient(options)` is the bare protocol, one method per
call, if you want your own loop.

## Rules for handlers

They are in the protocol page, and they matter more than the API:

- **Alert text is untrusted.** Labels and annotations are written by many systems. Never
  put them on a command line. In a prompt, pass them as data under a fixed instruction.
- **Bound an agent by its credentials and its network, not by its prompt**: read-only
  credentials, and no way to reach the Achtung server itself.
- **Your result is shown to everyone who can open the alert.** No secrets in it.

## Try it without a server

```bash
pnpm --dir sdk/typescript run dev                                     # a fake Achtung on :8790
pnpm --dir sdk/typescript run dev --token echo=a-long-example-token
```

The fake server has two made-up alerts and prints the `curl` commands that hand one over
and read the result. It keeps everything in memory. It applies the real server's limits
and state rules, which the conformance scenarios hold it to; its token check is simpler
(any listed handler's token is taken on the handover routes) and is not held to the real
one.

## Test your handler

`@achtung/handover-sdk/fake-server` starts the same fake server inside a test, with a
clock you control:

```ts
import { startFakeServer } from "@achtung/handover-sdk/fake-server";

let now = new Date("2026-01-01T10:00:00Z");
const server = await startFakeServer({ now: () => now });
// run your handler against server.url, POST /api/occurrences/1/handovers, assert on
// GET /api/handovers/1; move `now` to reach a lease or a deadline
await server.close();
```

`@achtung/handover-sdk/conformance` holds the protocol as scenarios against a server's
HTTP API. The real server and the fake server both pass them, which is what keeps the
fake honest. They are there for anyone who implements the server side again.

## Working on the SDK

```bash
pnpm --dir sdk/typescript run check   # typecheck, lint, dead code, duplication, tests
pnpm --dir sdk/typescript run fix
```

Node runs the TypeScript sources directly, so there is no build step. The types in
`src/protocol.ts` are written by hand from `api/openapi.yaml`; the conformance scenarios,
which the server's own tests run, are what holds them to it.
