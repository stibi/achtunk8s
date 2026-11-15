# 0023: A token for handlers

- Status: proposed
- Date: 2026-11-15

## Context

ADR 0002 says the application has no authentication: ingest and the client API are open,
and the operator's network is the access control. ADR 0022 adds a public API for
handlers, the programs that take an alert handed over to them and post a result back.

Built like every other route, that API would let anyone who reaches the server:

- register, replace or delete a handler, so a button appears, changes or disappears in
  every client;
- claim the handovers meant for the real handler and answer them, so an investigation
  never happens or a made-up "all fine" shows in the alert;
- claim handovers and hold them, which blocks the feature.

A forged analysis is new in kind. A fake alert looks like an alert; a forged result
looks like the outcome of an investigation, and a person may act on it.

The user decided on 2026-11-15 that handlers need a token.

## Decision

- **`HANDLER_TOKENS`**: a JSON object of handler id → token, read by `config.ts` and
  set from a secret, like `ALERTMANAGERS`.
- **When it is set, every handler route** (`/api/handler/…`) requires
  `Authorization: Bearer <token>`. A handler can register, claim, report progress and
  post results only under the id its token belongs to. A missing or wrong token is a
  401; a valid token used for another handler's id is a 403. Handlers not listed can't
  register.
- **When it isn't set, the handler routes are open**, like the rest of the API, so
  trying Achtung or running the demo needs no secret. The server logs a warning when a
  handler registers without it.
- **Only handlers.** The client routes, including creating, cancelling and reading
  handovers, and ingest stay as ADR 0002 has them. There are no users, no login and no
  roles; the token names a machine's program, not a person.
- Tokens are compared in constant time, never logged and never returned by any route.
  They are checked in one Fastify hook on the handler routes, the single place ADR 0002
  kept for this.
- The claim token of ADR 0022 stays. It answers a different question: not "is this a
  known handler" but "does this call hold this handover".
- The SDK always accepts a `token`, so a deployment can turn the check on without
  changing a handler.

## Consequences

- With the token set, only the configured handlers can offer actions and write results.
  Forged results, stolen handovers and rogue buttons need the secret, not only network
  access.
- It departs from ADR 0002 for one group of routes. ADR 0002 otherwise stands.
- Still open to anyone who reaches the server: creating a handover (starting somebody's
  agent), cancelling one, and using up the active handovers by creating them. A handler
  that acts on production stays bounded by its credentials and its network (ADR 0022).
- Adding a plugin now takes a change to the server's configuration and a restart: a new
  entry in the secret. Rotation is the same: change the entry, restart, update the
  handler.
- A new secret to keep. A leaked token lets its holder act as that one handler until it
  is replaced.
- Tokens travel in a header over plain HTTP where the operator's network carries
  Achtung without TLS (ADR 0002). Inside that network they can be read on the wire; a
  deployment that cares terminates TLS in front of the server.
- Rejected: no token (accepts forged results); a token required always (a first try
  would need a secret before anything works; the warning covers the unset case);
  actions fixed in the server's configuration with open claiming (stops rogue buttons,
  not stolen handovers); one token shared by all handlers (one leak exposes every
  handler, and a handler could answer for another).
