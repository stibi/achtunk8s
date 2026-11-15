# 0022: Plugins are handlers that pull handovers over a public HTTP API

- Status: proposed
- Date: 2026-11-15

## Context

The next feature is "Investigate with agent": one button that gives an alert to a coding
agent and brings its findings back. The first plan built it into Achtung for one setup (a
Claude agent in herdr on a VM). The user wants it as a plugin instead: a public,
documented API that their own case is written against, and that others can use for
theirs, for example a bot that asks a hosted model.

Constraints:

- No authentication and no users (ADR 0002). The server sits behind the operator's
  network.
- The server is one container running TypeScript sources from a read-only image. It
  holds the Alertmanager and IRM credentials.
- The agent's machine is reachable only from inside a private network, and should not
  have to accept connections.
- Alert labels and annotations are written by many systems and are untrusted. An agent
  that investigates holds read access to production.
- Golden principle 1: no extension point before there are two real implementations.

The plan with the details, the endpoint sketch and the phases:
[`docs/plans/agent-handover-plugins.md`](../plans/agent-handover-plugins.md).

## Decision

- **A plugin is a handler**: a separate program that connects out to the server,
  registers the **actions** it offers, takes the **handovers** for them and reports
  back. Nothing is loaded into the server or the client, and the server never connects
  to a plugin.
- **A handover** is one occurrence given to one action. States: `requested`, `running`,
  then `succeeded`, `failed`, `cancelled`, `timed_out` or `expired`. A person creates
  it with the action's button (`POST /api/occurrences/{id}/handovers`). At most one is
  active per occurrence and action; a repeat returns that one.
- **A handler claims by long poll** (`POST /api/handler/v0/handlers/{handler}/claim`), which
  finds and takes the oldest waiting handover in one step, so no two handlers get the
  same one. The answer carries the occurrence, its events and its other occurrences
  as the client API returns them (not earlier handovers) and a claim token that later
  calls for that handover must send. Inside the server the wait listens to the change
  feed of ADR 0019. The wait is 10 s by default, under the gateway's default timeout;
  up to 30 s is allowed where the gateway permits it.
- **A lease and a deadline end every handover.** The handler renews a two-minute lease
  with each progress call; when it runs out, the handover fails as "handler lost". The
  action's timeout (at most an hour) ends it as `timed_out`. One waiting unclaimed for
  10 minutes expires. Every call judges these limits against the clock itself; a sweep
  every minute only records the endings nobody asked about. A handover is delivered at
  most once and never retried
  automatically: a retry is a person pressing the button again.
- **The result** is a one-line summary, a Markdown body of at most 64 KiB and up to 10
  `http(s)` links, or an error text. No attachments. Clients render it as text, load
  nothing remote from it, and show which handler wrote it.
- **Actions are declared, not coded**: a title, a description, a timeout and which
  alerts they apply to (instances, severities, exact labels). The server decides which
  apply to an occurrence and lists them in its detail; the client draws the buttons. A
  handler counts as connected while it called (register, claim or progress) within the
  last 90 seconds; otherwise its button is disabled and a create is refused.
- **Handovers are kept**, with their progress lines, their result and the occurrence
  exactly as it was handed over. `changed: handovers` is a new kind on the change
  stream (ADR 0019).
- **The handler API is public and versioned in its path.** It is `v0`, free to change,
  until two reference handlers of different kinds exist (an agent in herdr; a hosted
  model). Then it is frozen as `v1`: additions only, handlers ignore unknown fields, a
  breaking change is a `/v2` served beside it for at least six months.
  `api/openapi.yaml` is the contract.
- **A TypeScript SDK** in this repo (`sdk/typescript`) wraps the loop: register, claim,
  renew, cancel as an `AbortSignal`, post the result. It ships a conformance suite, run
  against the real server and against a fake server for plugin authors, and a `curl`
  handler that shows the protocol needs no SDK. It is published when `v1` is frozen.
- **The plugin's process is called a handler** (the user's choice), `AlertHandler` in
  the server's code, so it isn't mistaken for a route handler.
- **No authentication is added by this ADR.** The handler routes take a bearer token;
  that is [ADR 0023](0023-handler-token.md).

## Consequences

- "Investigate with agent" becomes the first handler, not server code. Achtung gains no
  knowledge of herdr, Claude or any model, and no credentials for them.
- With ADR 0002 unchanged, anyone who reaches the server can register, replace or
  delete a handler, take and answer handovers meant for another handler, cancel a
  handover, use up the 20 active handovers, and start an agent by creating one. The
  handler-side ones are what the handler token closes (ADR 0023). Creating and cancelling
  stay open, so a handler that acts on production must be bounded by its credentials and
  its network, not by its prompt: read-only credentials, and an agent that can't reach
  the Achtung server, which is open and can silence alerts. Read-only credentials don't
  stop an agent from sending out what it may read. The plugin docs say so, and the
  reference handler is built that way.
- A result is untrusted text shown inside an alert. The client must never load remote
  content from it, open a link in it that isn't `http(s)`, or treat it as Achtung's own
  statement.
- The server grows three tables, a sweep that runs every minute, and up to 20 held
  claim requests. No gateway or deployment change is needed for the server.
- A public API is a promise. Until `v1` it can change freely; after it, the handover
  states and result outcomes are closed sets.
- Handlers poll: an idle handler makes a request every 10 seconds. At this scale that is
  nothing.
- Outbound webhooks can be added later as a bridge handler without changing the server.
- Rejected: outbound webhooks as the contract (the server would call URLs registered by
  unauthenticated callers, and needs delivery, retries and signing); plugins loaded
  into the server (third-party code beside the database and the Alertmanager
  credentials, a rebuild to install one); plugins in the macOS client (one Mac only,
  production access from the laptop); handlers listening to `/api/events` and claiming
  with a conditional update (three calls and a race where one call does, and SSE in
  every language); automatic retries (a handler that only looks dead would get a twin).
