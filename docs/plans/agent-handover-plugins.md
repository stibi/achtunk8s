# Plan: hand an alert over to a plugin (handlers, actions, handovers)

Status: **agreed 2026-11-15; phase 2 (the server) is built**, the other phases are not
started. The decisions are in section 9 and in ADR 0022 and ADR 0023 (accepted). What
was built and where it differs from the sketch below: [Progress](#progress).
It changes the public API and the schema, so each phase waits for the user's OK
(AGENTS.md). Prerequisite: the change stream (ADR 0019) merged to `main`.

It reshapes section 2 of
[`dead-mans-switch-and-agent-handover.md`](dead-mans-switch-and-agent-handover.md)
("Investigate with agent"). What stays from it and what changes is listed
[at the end](#what-stays-from-the-earlier-plan).

The goal: "Investigate with agent" is not built into Achtung. Achtung gets one small,
public, documented way to hand an alert over to a program outside it, and the herdr and
Claude investigation is the first program written against it. Somebody else writes theirs
without touching Achtung.

---

## 1. What a plugin is

**A plugin is a handler: a separate program that connects out to the Achtung server over
a public HTTP API, says which actions it offers, takes the handovers for them and
reports back.** Nothing is loaded into the server or into the macOS client.

Three words, used everywhere below:

- **Handler**: the plugin's process, e.g. `herdr-agent` on a VM. It has an id. (The
  user's choice of name. In the server's code it is always `AlertHandler`, never a bare
  `Handler`, so it can't be mistaken for a Fastify route handler; golden principle 5.)
- **Action**: something a handler offers for an alert, e.g. "Investigate with Agent". A
  button in the client. Identified by its handler's id and its own id, as a channel is by
  instance and name (ADR 0006).
- **Handover**: one alert (an occurrence) given to one action, with its state, progress
  and result.

### The shapes compared

| Shape | How it would work | Verdict |
|---|---|---|
| **Handlers that pull over HTTP** | The handler connects out, registers, asks for work, posts the result. | **Chosen.** |
| Outbound webhooks | The server POSTs the alert to a URL and waits for a callback. | Rejected as the contract; possible later as a handler (below). |
| In-process server plugins | npm packages the server loads at startup. | Rejected. |
| macOS client plugins | Code or scripts the Mac app runs. | Rejected. |

**Why handlers that pull:**

- **No inbound connection to the plugin.** The agent VM only reaches the server, like
  any client. No listener on the VM, no SSH keys or VM access in the Mac app. This is the
  earlier plan's decision, and it is how GitHub's self-hosted runners work: the runner
  opens an outbound HTTPS long poll for jobs, and GitHub never connects to it [1].
- **The server never calls a URL somebody registered.** With ADR 0002 anyone who reaches
  the server could register a webhook URL, and the server would then send requests from
  inside the cluster to wherever it points (request forgery). Webhooks also bring a
  delivery queue, retries, signing and a response deadline, which every webhook system
  has to specify: Alertmanager has a timeout after which a webhook request is retried
  [2], and Grafana IRM and PagerDuty give the endpoint a few seconds to answer and
  retry failures [3][4]. A pull has none of that: the handler asks when it is ready.
- **Any language, any place.** The contract is HTTP and JSON, usable from `curl`. A
  handler runs on a VM, as a container next to Achtung or on a laptop.
- **Plugin code and plugin secrets stay out of the server.** An in-process plugin (the
  Backstage model: modules against extension points, built into the backend [5]) would
  run third-party code with the server's database and Alertmanager credentials, need
  `kubectl` or an LLM key inside the server's pod, and need a rebuild of the image to
  install. The server runs TypeScript sources without a build step from a read-only
  image; that model fits a platform with a build and a plugin ecosystem, not this.
- **Every client gets it.** The button lives in the API, so a second Mac or a later iOS
  app shows the same actions. A client-side plugin would exist on one Mac only and would
  need production access from the laptop.

**What we take from the others:**

- From Sentry's integration platform [6]: the integration *declares* its UI (an "alert
  rule action" with a title and fields) and the product renders it. Here: an action
  declares a title, a description and which alerts it applies to; the client renders a
  button. No plugin code runs in the client.
- From PagerDuty's custom incident actions [4] and Grafana IRM's webhook triggers [3]: a
  person presses a named action on one incident. Rules that hand alerts over on their
  own are a later step, not v1.
- From GitHub Actions [1]: the handler asks for a job over a long poll. The lease that
  the handler keeps alive, and failing a job whose handler disappeared, is the usual
  companion of that model (our choice, not taken from GitHub's documentation).

**Webhooks later, without a second contract.** Someone who wants "POST the alert to my
URL" runs a small bridge handler that claims handovers and forwards them. It is a handler
like any other, configured by its operator (so no URL comes from an unauthenticated
caller), and the server stays unchanged.

**Golden principle 1** says no extension points before there are two real
implementations. This one crosses a process boundary, and the plan builds two
implementations of different kinds before the API is called stable: until then it is
`v0` and may change (see versioning).

---

## 2. The contract

### Lifecycle

```
            create                    claim                     result
 (client) ─────────▶ requested ─────────────▶ running ─────────────────▶ succeeded
                        │                        │ ────────────────────▶ failed
                        │ cancel                 │ cancel                (handler's own
                        ▼                        ▼                        failure, or the
                    cancelled                cancelled                    lease ran out)
                        │                        │
                        │ nobody claimed         │ deadline passed
                        ▼ within 10 min          ▼
                     expired                 timed_out
```

- **Create.** A person presses the action's button: `POST
  /api/occurrences/{id}/handovers`. Only that in v1. Because it is a plain API call, a
  script or a later rule can create one too; automatic handovers are deliberately left
  out (cost, noise, and an agent started by alert text nobody looked at).
- **One active handover per occurrence and action.** A second create while one is
  `requested` or `running` returns the existing one (200, not 201). Two Macs or a
  double click don't start two agents.
- **Claim.** The handler asks for the next handover of its actions. The server picks the
  oldest `requested` one and moves it to `running` in one conditional update (`FOR
  UPDATE SKIP LOCKED`), so two handlers offering the same action never get the same
  handover. The answer carries a **claim token**, which every later call for this
  handover must send. It is a fencing token, not an identity: a handler that lost its
  lease, or another handler, can't write into a handover it doesn't hold. It is never
  returned by a read.
- **Lease.** A running handover has a lease of 2 minutes. Every progress call renews
  it (the SDK sends one every 30 seconds). A lease that runs out means the handler is
  gone: the handover becomes `failed` with the reason `handler lost`.
- **Deadline.** The action declares `timeoutSeconds` (default 900, at most 3600). Past
  it the handover becomes `timed_out`.
- **Progress.** Short status lines ("agent `inv-482` started", "waiting for your input
  in herdr"). Kept as the handover's history. A progress call after the handover ended
  changes nothing and answers with its state.
- **Cancel.** From the client: `requested` or `running` becomes `cancelled` at once.
  The handler learns it from its next progress call, whose answer carries the state, and
  stops its work.
- **Result.** `succeeded` with a one-line summary, a Markdown body and links, or
  `failed` with an error text. Sent once; the same result sent again with the same token
  is answered as before, a different one is a 409. A result for a handover that was
  cancelled, timed out or failed in the meantime is a 409.
- **At most once, no automatic retries.** A handover is given to at most one handler,
  once. Starting an agent costs money and attention, and a handler that only looks dead
  must not get a twin. A failed handover says why; the person presses the button again,
  which is a new handover. A handler that crashes between the claim and reading its
  answer loses that handover to `handler lost` after two minutes.
- **The clock decides, not the sweep.** Every call (create, claim, progress, result,
  cancel) first judges the handover against the clock inside its own conditional
  update: a `requested` one older than 10 minutes is `expired` and can't be claimed or
  returned as "the existing one"; a run-out lease is `failed`, and a progress call can't
  revive it; a result after the deadline is refused. So the limits are exact and
  testable with a fake clock. **A sweep**, every minute, started and stopped by
  `main.ts` like the reconciler, only records the endings nobody asked about, so
  clients hear of them.
- Every state change and every recorded progress line publishes `changed: handovers`
  on the change stream (a new `ChangeKind`, ADR 0019), so clients re-read the open
  alert.

### How a handler learns of work: a long poll, not the stream

`POST /api/handler/v0/handlers/{handler}/claim?wait=10` answers at once when a handover is
waiting, else holds the request for up to `wait` seconds and answers 204. Inside the
server the wait is a subscription to the change feed (`services/changes.ts`), so it
builds on ADR 0019 without handlers having to speak SSE.

Why not "listen on `/api/events`, list, then claim":

- One call instead of three, and finding and claiming is atomic. No lost race to handle.
- Usable from a shell loop with `curl`. SSE parsing in every language is not.
- ADR 0019's stream keeps saying only "something changed" and carries no data.
- Each claim call also tells the server the handler is alive (below).

`wait` defaults to 10 seconds, under Envoy's default route timeout of 15 s (ADR 0019),
so the handler API needs **no gateway change**. A handler may ask for up to 30, which
needs the route's timeout raised as for `/api/events`. Details that keep at-most-once
honest:

- Before it claims for a held request, the server checks that the request is still
  open, so a handover isn't given to a connection that went away. One lost after that
  check fails as `handler lost` two minutes later.
- At most 20 claims wait at once; another is answered 503, as the change stream does at
  its limit, and the handler backs off.
- Closing the server ends the held claims with 204 (`preClose`, as `http/events.ts`
  ends its streams).

A handler may also listen to `/api/events`; it doesn't have to.

### Endpoints (sketch)

Client side, tag `client`, alongside the existing routes:

```yaml
/api/occurrences/{id}:                  # existing; the detail gains two fields
  get:
    # actions:   [ActionOffer]   the actions that apply to this occurrence
    # handovers: [Handover]      this occurrence's, newest first, up to 20
    # (both optional in the spec until the macOS client reads them, phase 4)

/api/occurrences/{id}/handovers:
  post:
    requestBody: { handler: string, action: string }
    responses:
      201: Handover           # created
      200: Handover           # one was already requested or running: that one
      400: Error              # invalid body
      404: Error              # unknown occurrence
      409: Error              # unknown action, it doesn't apply to this alert,
                              # or its handler isn't connected
      503: Error              # 20 handovers are active already

/api/handovers:
  get:                        # ?state=&cursor=&limit=  newest first: the audit list
    responses: { 200: { handovers: [Handover], nextCursor } }

/api/handovers/{id}:
  get: { responses: { 200: Handover, 404: Error } }

/api/handovers/{id}/cancel:
  post: { responses: { 200: Handover, 400: Error, 404: Error, 409: Error } }   # 409: already ended
```

Handler side, tag `handler`, the public plugin API:

```yaml
/api/handler/v0/handlers/{handler}:        # handler id: ^[a-z0-9][a-z0-9-]{0,62}$
  put:                                  # register; repeat it to change the actions
    requestBody: HandlerRegistration
    responses: { 200: Handler, 400: Error }
  delete: { responses: { 204 } }        # going away for good; its buttons disappear

/api/handler/v0/handlers/{handler}/claim:
  post:                                 # ?wait=0..30 (default 10)
    responses:
      200: ClaimedHandover
      204: {}                           # nothing to do
      404: Error                        # not registered (register, then claim again)
      401, 403: Error                   # with HANDLER_TOKENS set: no or wrong token, or
                                        # another handler's id (on every handler route)
      503: Error                        # too many claims are waiting; back off

/api/handler/v0/handovers/{id}/progress:
  post:                                 # header  Achtung-Claim: <claim token>
    requestBody: { message?: string }   # no message: only renew the lease
    responses:
      200: { state: <any handover state>, leaseSeconds }   # not `running`: stop
      403: Error                        # wrong or missing claim token
      404: Error

/api/handler/v0/handovers/{id}/result:
  post:                                 # header  Achtung-Claim: <claim token>
    requestBody: HandoverResult
    responses: { 200: Handover, 403: Error, 404: Error, 409: Error }
```

Schemas:

```yaml
HandlerRegistration:
  name: string                 # shown in the client, ≤ 60
  version: string              # the handler's own version, ≤ 40
  actions:                     # 1..10
    - id: string               # ^[a-z0-9][a-z0-9-]{0,62}$
      title: string            # the button, ≤ 40, e.g. "Investigate with Agent"
      description: string      # the button's help text, ≤ 200
      timeoutSeconds: integer  # 60..3600, default 900
      appliesTo:               # all given parts must match; none given: every alert
        instances?: [string]
        severities?: [critical | warning | info | unknown]
        labels?: { name: value }      # exact, like `label=` in search (ADR 0017)

ActionOffer:                   # in an occurrence's detail
  handler: string
  handlerName: string
  action: string
  title: string
  description: string
  available: boolean           # the handler called within the last 90 s
  lastSeenAt: date-time

Handover:                      # one of, by `state` (a discriminated union)
  id, occurrenceId, handler, handlerName, handlerVersion, action, title, requestedAt
  state: requested
  state: running     + claimedAt, deadlineAt
  state: succeeded   + claimedAt, finishedAt, summary, body, links
  state: failed      + claimedAt, finishedAt, error
  state: cancelled   + finishedAt, claimedAt (null when it was never claimed)
  state: timed_out   + claimedAt, finishedAt
  state: expired     + finishedAt
  progress: [{ at: date-time, message: string }]      # oldest first

ClaimedHandover:
  id: integer
  action: string
  claimToken: string
  leaseSeconds: integer        # renew before this passes
  deadlineAt: date-time
  requestedAt: date-time
  occurrence: Occurrence       # as GET /api/occurrences/{id} returns them, without
  events: [OccurrenceEvent]    # `actions` and `handovers`: earlier results are
  otherOccurrences: [Occurrence]   # untrusted text and don't go into the next prompt

HandoverResult:                # one of, by `outcome`
  outcome: succeeded
    summary: string            # one line, plain text, ≤ 300
    body: string               # Markdown, ≤ 64 KiB
    links: [{ title: string, url: string }]     # ≤ 10, http or https only
  outcome: failed
    error: string              # ≤ 2000
```

No attachments in v1: the server writes nothing to disk, and a result links to what it
found (a dashboard, a log query) instead of copying it.

### Versioning and compatibility

- The handler API has its version in the path. It is **`v0` until both reference
  handlers exist**, and may change without notice until then. Then it is frozen as
  **`v1`**.
- Within `v1`, only additions: new optional request fields, new response fields, new
  endpoints. Handlers must ignore fields they don't know. Handover states and result
  outcomes are closed sets in `v1`; a new one means `v2`.
- A breaking change is a new `/v2` served next to `/v1` for at least six months, and it
  gets an ADR.
- The client routes (`/api/occurrences/…`, `/api/handovers`) stay unversioned like the
  rest of the client API; the macOS client is their only consumer today.
- `api/openapi.yaml` is the contract. `check` already fails when it is out of date, so
  its diff is the API review.

---

## 3. Registration and discovery

- **A handler announces itself** with `PUT /api/handler/v0/handlers/{handler}` at startup:
  its name, version and actions. The call is idempotent; a handler repeats it after a
  404 from claim (the server forgot it) and when its actions change. Registrations are
  stored, so a server restart doesn't lose the buttons.
- **Alive means calling.** A handler's `lastSeenAt` is its last register, claim or
  progress call. Seen within 90 seconds: its actions are `available`. A handler at its
  own concurrency cap stops claiming but keeps renewing its leases, so it stays
  available.
- **A busy handler queues.** A handover created while the handler is at its cap waits as
  `requested` and is claimed when a slot frees up, or expires after 10 minutes, which
  the client shows as "herdr agent was busy".
- **The client asks the server, per alert.** The occurrence detail lists the actions
  that apply; the server evaluates `appliesTo`, so the rule has one implementation. The
  client draws a button per action, with the handler's title and help text.
- **Handler registered but not connected:** the button is there, disabled, with "herdr-agent
  hasn't connected since 14:05". The server refuses a create for it (409) rather than
  queueing work that would expire.
- **No handler at all:** nothing is shown. "Copy for Agent" stays as it is, the manual
  way that needs no plugin.
- **A handler that never comes back:** its registration is deleted after 30 days without
  a claim (by the sweep), or at once by its own `DELETE`. Its past handovers stay; they
  carry the handler's name and the action's title themselves.
- Limits: 50 handlers, 10 actions each.

---

## 4. Trust and safety

### What ADR 0002 already accepts, and what this adds

Today anyone who reaches the server reads every alert, can inject fake ones and can
silence real ones. Access control is the operator's network. The handover API, built the
same way, adds this for anyone who reaches the server:

1. **Register, replace or delete a handler**: a button appears in every client, or a
   real handler's button changes its text, its `appliesTo`, or disappears.
2. **Claim handovers** meant for the real handler, and answer them: the investigation
   never happens, or a made-up "all fine" result shows in the alert. This is new in
   kind: a forged *analysis* that a person may trust.
3. **Create a handover**: start somebody's agent. Together with an injected fake alert,
   that is a way to feed chosen text to an agent that holds read access to production,
   with no person in between.
4. **Cancel** anyone's handover.
5. **Block the feature**: fill the 20 active handovers, or with a self-registered
   handler claim them and hold them for up to an hour. The cap protects handlers and the
   server; it is also the thing to exhaust.

Points 3, 4 and the creating half of 5 can't be closed without authenticating clients,
which is ADR 0002 itself. So the handler is the last line: what its agent can do is
bounded **by its credentials and its network, not by its prompt** (guardrails below).
Points 1, 2 and the handler half of 5 can be closed:

### Decided: a handler token (ADR 0023)

- `HANDLER_TOKENS`, a JSON object of handler id → token, set from a secret, like
  `ALERTMANAGERS`. When it is set, every handler route requires `Authorization: Bearer
  …`, and only the listed handlers can register, claim and answer, each under its own
  id. The server compares tokens in constant time and never logs or returns them.
- When it isn't set, the handler routes are open like the rest of the API, so a first
  try and demo setups need no secret. The server logs a warning at startup when
  handlers register without it. The user's deployment sets it.
- It is a credential for a machine. There are still no users and no login, and the
  client routes (create, cancel, read) stay open, as ADR 0002 says.
- The SDK always takes a `token`, so a deployment turns it on without changing a
  handler.
- Closes points 1, 2 and the handler half of 5. Considered and rejected: no token at
  all (accepts forged results), and actions fixed in the server's configuration (stops
  rogue buttons but not stolen handovers, and every new plugin needs a redeploy).

Either way: a result shows which handler (name, version) wrote it, and only the handler
that claimed a handover can answer it (the claim token).

### What a handler can read and do

- **Read:** what the client API returns. A claim carries the occurrence as `GET
  /api/occurrences/{id}` returns it, nothing more.
- **Do:** register actions, claim, report progress, post a result. A handler gets no
  special way to silence, resolve or change an alert. (The open client API lets anyone
  silence, ADR 0002; a handler has no business calling it, and the reference handlers
  never do.)
- **Never in a handover payload:** anything from the server's configuration:
  Alertmanager URLs and credentials (`ALERTMANAGERS`), the IRM token, the database URL.
  The payload is built from the occurrence's API schema only, and a test asserts that.

### How the server stays safe from a bad handler

- Plugin code never runs in the server, and the server never calls a plugin.
- Every request is parsed by a Zod schema at the boundary (golden principle 3). Sizes
  are bounded: result body 64 KiB, summary 300 characters, 10 links, a progress message
  500 characters, 200 progress entries per handover (further ones only renew the lease),
  50 handlers, 10 actions each, 20 waiting claims.
- Leases, deadlines and the sweep end every handover; nothing stays `running` forever.
- At most one active handover per occurrence and action, and at most 20 active on the
  server (a further create is a 503), so a loop that creates handovers can't flood a
  handler.

### What the client does with a result

A result is **untrusted text** from another program, possibly written by an agent that
read attacker-influenced alert text.

- Markdown is rendered as text: no HTML, **no remote images or other remote content
  loaded** (an image URL is the classic way to leak data out of a prompt-injected
  agent).
- Links open only on a click and are `http` or `https`, both the `links` array and
  links inside the Markdown body. A body link whose text differs from its target shows
  the target next to it; one with another scheme stays plain text.
- The result is marked as coming from the handler, never styled as Achtung's own
  judgement, and never changes an alert's state.

### Guardrails for agents acting on production (carried over, sharpened)

These are rules for handlers; the reference handler implements them, and the plugin docs
state them for other authors.

- **Alert labels and annotations are untrusted input**; many systems write them. A
  fixed prompt template with the alert fenced as data. Alert text is never put into a
  shell command line: the handler passes it as a file or as an argument vector.
- **Read-only by credentials.** The agent's kubeconfig and Grafana token can only read
  (a `view`-like role without secrets, a Viewer service account). The agent's tool
  allowlist is the second layer, not the first.
- No writes to clusters, Vault, Terraform or git remotes; the operator's own stop rules
  apply; never silence or unsilence alerts.
- **The agent never holds the claim token** and has no need to reach Achtung: it
  writes its findings to a file, and the handler posts them.
- **What read-only credentials don't cover**, said plainly:
  - *Achtung itself.* The agent's machine reaches the server, which is open (ADR 0002)
    and holds the Alertmanager credentials. An agent talked round by alert text could
    silence alerts through Achtung, create handovers or re-register handlers. So "never
    silence" holds only if the agent can't reach the server: the reference handler must
    deny it (a network or tool rule, settled in the spike), and until that is shown to
    work it is an accepted risk the user knows about.
  - *Reading and telling.* Whatever the agent may read (logs, config maps, pod
    environments) it can also send anywhere it has a way out to. Keep secrets out of
    its reach and its outbound access as narrow as its tools need.
- One active handover per occurrence and action; a deadline; a cap on concurrent
  handovers in the handler.
- **Secrets:** the server stores none for plugins. LLM keys and cluster credentials
  live with the handler. A result is readable by everyone who reaches the server, so the
  prompt forbids printing secret values and the credentials can't read them.
- **A hosted LLM means alert data leaves the network.** Labels carry hostnames and
  topology. Such a handler is the operator's explicit choice, and it can drop named
  labels and annotations before sending.
- No real hostnames in anything committed (fixtures, examples, docs).

### Audit trail

- A handover is never deleted. It records who (which handler and action), when
  (requested, claimed, finished), every progress line, the final state and the result.
- **What was handed over:** the claim stores its payload exactly as the handler
  received it (`snapshot`: the occurrence, its events and its other occurrences),
  because an occurrence's row keeps only the latest reported fields.
- Not recorded: who pressed the button. There are no users (ADR 0002).
- `GET /api/handovers` lists them all, newest first.

---

## 5. The SDK

- **The contract is `api/openapi.yaml`** (the `handler` tag) plus one page of prose,
  `docs/handover-protocol.md`: the state machine, the timing rules (lease, deadline,
  wait), the limits, the compatibility promise and the guardrails for handler authors.
- **One thin SDK, TypeScript**, in this repo at `sdk/typescript/` as a pnpm workspace
  package. Types generated from the spec; a hand-written `runHandler`:

  ```ts
  await runHandler({
    server: "http://achtung.example",
    id: "herdr-agent",
    name: "herdr agent",
    version: "0.1.0",
    token: process.env.ACHTUNG_HANDLER_TOKEN,   // required when the server sets HANDLER_TOKENS
    maxConcurrent: 2,
    actions: [{
      id: "investigate",
      title: "Investigate with Agent",
      description: "Starts a Claude agent in herdr, read-only.",
      timeoutSeconds: 1200,
      async handle(handover, { progress, signal }) {
        // signal aborts on cancel, deadline or a lost lease
        await progress("agent started");
        return { outcome: "succeeded", summary: "…", body: "…", links: [] };
      },
    }],
  });
  ```

  It registers, runs the claim loop with backoff, renews leases on a timer, turns a
  cancel or a deadline into the `AbortSignal`, posts the result, and turns a thrown
  error into `failed`. No runtime dependencies (Node's `fetch`). It also exports
  `agentReport(occurrence)`, the alert as Markdown for a prompt, matching the client's
  `AgentReport`; both are tested against the same expected files.
- **No second SDK yet.** Instead a `curl` handler of about 40 lines in the protocol
  page, run in CI against a real server. It proves the protocol needs no SDK and is the
  starting point for any other language. A Python SDK when somebody asks for one.
- **A conformance suite**: the protocol's rules as black-box HTTP scenarios (register,
  claim once only, lease runs out, cancel while running, result twice, limits), taking a
  base URL. The server's own tests run it against the real server with Postgres
  (Testcontainers).
- **A fake server for plugin authors**: `achtung-handover dev`, part of the SDK
  package. An in-memory handler API with made-up alerts and a command to hand one over,
  so an author tries a handler without Postgres or a cluster. The conformance suite runs
  against it too, which keeps it from drifting. (The real server's image is built in CI
  but not published, so "run the real one" is not yet an easy answer.)
- **Versioning:** the SDK's major version is the protocol's: `0.x` speaks `v0`, `1.x`
  speaks `v1`.
- **Publishing:** not at first. The reference handlers use it through the workspace. At
  the `v1` freeze it goes to npm from CI with provenance; the scope name and the
  publishing workflow are the user's decision then.
- **Docs:** `sdk/typescript/README.md` (a handler in ten minutes), the protocol page, a
  "Plugins" page on the website at the `v1` freeze (the site has only its index page
  today), a section in `docs/architecture.md`, the new commands in `AGENTS.md`.
- The package gets its own `check` (typecheck, lint, tests, dead code) and a CI job,
  with the server's rules (ADR 0003).

---

## 6. Data model and UI

### Schema (one migration per phase that needs it)

- `handover_handlers`: `id` (text, primary key), `name`, `version`, `actions` (jsonb,
  parsed on read), `registered_at`, `last_seen_at`.
- `handovers`: `id`, `occurrence_id` (references `occurrences`), `handler_id`,
  `handler_name`, `handler_version`, `action_id`, `action_title` (copied, so history
  outlives the handler), `state` (enum), `requested_at`, `claimed_at`,
  `lease_expires_at`, `deadline_at`, `finished_at`, `claim_token`, `snapshot` (jsonb),
  `summary`, `body`, `links` (jsonb), `error`. A partial unique index on
  `(occurrence_id, handler_id, action_id)` where the state is `requested` or `running`.
  Check constraints tie the nullable columns to the state; the domain type is a union by
  state (golden principle 4).
- `handover_progress`: append-only, `handover_id`, `message`, `recorded_at`.

Layers as usual: the lifecycle (`nextState`, what applies to an occurrence) is pure code
in `domain/handover.ts`; `db/handovers.ts`; `services/handovers.ts` owns the
transactions and publishes changes; `http/handovers.ts` and `http/handler.ts` are thin.

A result attaches to the **occurrence**, not the alert: it is about this firing. The
alert's other occurrences are already linked from the detail, and each shows its own
handovers.

### macOS client

- `AlertDetails`: beside "Copy for Agent", one button per applicable action, titled by
  the action ("Investigate with Agent"); a menu "Hand Over" when there are more than
  two. Disabled with the reason when the handler isn't connected. Also in a list row's
  context menu.
- A **handover card** under the alert's links, for the newest handover of each action:
  - `requested`: "Waiting for herdr agent…" and Cancel.
  - `running`: a spinner, how long, the latest progress line, Cancel.
  - `succeeded`: the summary as the headline, the body as Markdown text, the links as
    buttons, then "herdr agent 0.1.0 · 14:05–14:12". Copy button.
  - `failed`, `timed_out`, `expired`, `cancelled`: one calm line with the reason, and
    the action's button to try again.
- **History:** older handovers of the occurrence folded below the card, newest first.
- **Notification** "<action title> finished: <alert title>", only on the Mac that
  pressed the button (it remembers the ids it created; the server keeps no per-client
  state). A switch in Settings' Notifications tab.
- It updates through `changed: handovers` on the stream and the normal refresh.
- `AchtungDomain`: `Handover` as an enum by state, `ActionOffer`; the mapping rejects
  impossible combinations as it does elsewhere. `AchtungAPI`: mapping and fixtures.
- Not in v1: a mark on list rows for "being investigated" (it needs a field on every
  listed occurrence), results in search (ADR 0017).

### Demo mode and the public face

- `macos/scripts/demo-server.py`: one made-up action, "Investigate with Agent", whose
  handover walks `requested` → `running` with three progress lines → `succeeded` with a
  canned, made-up result after about 8 seconds; one alert that already has a finished
  one; `POST /demo/handover-fail` for the failure states.
- `docs/media/SHOTLIST.md`: retake `alert-detail.png` with a result; a new clip of
  pressing the button to the result; the demo tour re-recorded when the feature ships.
- `README.md` and the website: the feature, and that it needs a handler; the roadmap
  item moves to "what exists" only when it does.

---

## 7. The two reference handlers

Both live in this repo as workspace packages under `handlers/`, written with the SDK,
with made-up examples only. An operator's own settings (which clusters, which MCP
servers, the agent's permission file) stay outside the repo.

### `handlers/herdr-agent`: an agent in a terminal, on a VM

- **Process:** a systemd user service on the agent VM, next to a running herdr server.
  Outbound only. Config file: server URL, handler id, optional token, agent kind
  (`claude` by default; herdr knows many), the agent's arguments (the restricted
  profile), the prompt template, `maxConcurrent` (default 1), the timeout, whether to
  keep the pane afterwards.
- **Per handover:**
  1. Make a working directory for it; write `alert.md` (`agentReport`) there.
  2. `herdr workspace create`, labelled `achtung-<id>`, not focused; take the root pane
     from the JSON answer.
  3. `herdr agent start inv-<id> --kind claude --pane <pane> -- <profile args>`.
  4. `herdr agent prompt inv-<id> "<fixed text>"`: the fixed template only, which tells
     the agent to read `alert.md`, investigate read-only and write its findings to
     `result.md` in that directory. No alert text on a command line.
  5. Progress: "agent `inv-<id>` started in workspace …", so the user can open the pane
     and **steer the conversation**, the reason for herdr over a headless run.
  6. `herdr agent wait` in a loop with the lease renewed. `blocked` becomes the
     progress line "waiting for your input in herdr". Settled: read `result.md`, check
     its size, post it. No file: `failed`, with the tail of `herdr agent read`.
  7. Cancel or deadline (the SDK's signal): interrupt the agent (`send-keys esc`), keep
     the pane for the user unless configured otherwise.
- **Guardrails:** section 4. The profile's allowlist (read, search, `kubectl
  get|describe|logs|top`, read-only Grafana/Loki/Prometheus tools, writing only inside
  the handover's directory) over read-only credentials.
- **To settle in the spike (phase 1):** whether a service outside a herdr pane may
  drive herdr (its agent guide tells agents to control it only from inside a pane; the
  CLI has `--session`), or whether the handler itself runs in a pane of its own
  workspace; the exact restricted profile; how the agent is kept from reaching the
  Achtung server; whether the findings are worth having.
- **Proves:** minutes-long work, progress, a person taking over mid-way, cancel, lease
  and deadline, a concurrency cap, a result collected by the handler and not sent by the
  agent.

### `handlers/llm-analysis`: a hosted model, no terminal, no VM

- **Process:** a stateless program, run as a container next to Achtung or anywhere
  that reaches the server and the model's API. Config from the environment:
  `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, labels and annotations to drop,
  `maxConcurrent`. It speaks the OpenAI-compatible chat API, which xAI's Grok offers at
  `https://api.x.ai/v1` [7], so the same handler serves other providers and a local model. **Running it against a
  local model is part of the work, not an afterthought** (the user's decision): a spike
  first, then a documented example, so there is a setup where no alert leaves the
  network.
- **Per handover:** one request with a fixed system prompt and the alert, redacted and
  fenced as data; the answer is the result's body, its first line the summary. Seconds,
  not minutes. No tools, no cluster access: it explains the alert and suggests where to
  look, it doesn't investigate.
- Action: "Explain with Grok" (the title is configuration).
- **Proves the SDK isn't shaped around herdr:** no terminal and no progress to speak
  of; several handovers at once; two different actions offered on the same alert by two
  handlers (the client's menu); a handler inside the cluster; its secret wholly on its own
  side; alert data leaving the network as the operator's explicit choice.

If either handler needs something the contract lacks, the contract changes while it is
still `v0`. That is the point of building both before the freeze.

---

## 8. Phases

Each is one reviewable change (or two where noted), ends with `check` green and the
`reviewer` subagent, and updates the docs it touches.

| # | What | Changes | Needs the user's OK | Tests | Docs |
|---|---|---|---|---|---|
| 0 | Accept ADR 0022 and ADR 0023 (the plan and its decisions are agreed). ADR 0019 merged. | none | accepting the ADRs | | ADR 0022, 0023 → accepted |
| 1 | **Spike on the VM**, thrown away: a hand-run script takes an occurrence id, builds `alert.md`, starts the restricted agent in herdr, collects `result.md`. | none in the repo | the agent's own read-only kubeconfig and Grafana Viewer token, made first | by hand, on a few real alerts | findings into this plan |
| 2 | **Server.** The three tables; register and delete a handler; `actions` and `handovers` in the occurrence detail; create, cancel, claim with the long poll, progress, result; the sweep; `changed: handovers`. The handler token (`HANDLER_TOKENS`). One phase, because a handler is only "available" once it can claim; reviewable as two commits (handlers and actions, then handovers). So that nothing goes red: the two new detail fields are optional in the spec until phase 4, and the same change adds the new change kind to the Swift mapping (a new enum value isn't safe for the generated client otherwise), extends the `AchtungAPI` fixtures and makes `demo-server.py` return `actions: []` and `handovers: []`. | API, schema; a config key and a secret in the deployment | yes (ADR 0022, ADR 0023) | lifecycle and `appliesTo` as pure domain tests; two handlers claiming one handover; lease, deadline and expiry with a fake clock, with and without the sweep; the token: missing, wrong, another handler's, and unset; a claim whose request went away; limits; the payload holds no configuration and no earlier handovers; the Swift package tests on Linux | `architecture.md`, `docs/handover-protocol.md` |
| 3 | **SDK**: `sdk/typescript`, the conformance suite, the fake server, the `curl` handler. | a new package and CI job; the root `Dockerfile` must still build with more packages in the workspace; nothing deployed | no | the suite against the real server and the fake; SDK unit tests | SDK README, protocol page, `AGENTS.md` commands, ADR 0003 note |
| 4 | **macOS**: buttons, the handover card, cancel, history, notification; domain and API mapping; demo mode. Can run beside phase 3. | client | no | domain and mapping tests on Linux; app tests and `check.sh` on macOS | README, website, `SHOTLIST.md` and shots |
| 5 | **`handlers/herdr-agent`**, from the spike. Run on the user's VM. | a new package; the user's VM | the VM setup | unit tests with a fake `herdr` on the path; a run against the fake server | its README, a systemd unit example |
| 6 | **`handlers/llm-analysis`**, with a container image and an example manifest. Two setups, both required for the phase to count as done: a hosted model (xAI's Grok), and **a local model** behind an OpenAI-compatible server, first as a short spike, then kept as a documented example. | a new package; a deployment if it runs in a cluster | yes, for deploying it and its secret | unit tests with a fake model API; a run against the local model | its README, with both setups |
| 7 | **Freeze `v1`**: review the contract against both handlers, rename `v0` → `v1`, the website's Plugins page, publish the SDK. | API (the rename), a publishing workflow | yes: publishing, the npm scope | the suite unchanged | website, README, ADR 0022 updated with what changed |

Later, each its own decision: a webhook bridge handler; automatic handovers by rule; a
note from the user with the handover; a mark on list rows; results in search; an "Open
in Rex" link; attachments; a Python SDK.

**ADRs:** 0022 (plugins are handlers that pull handovers) and 0023 (the handler token),
both drafted as proposed. ADR 0019 gets the new change kind noted in 0022, not a new
ADR.

---

## 9. Decisions (the user, 2026-11-15)

1. **A handler token: yes.** `HANDLER_TOKENS`, built in phase 2 and set in the user's
   deployment (section 4, ADR 0023).
2. **The names: handler, action, handover.** The plugin's process is a *handler*
   (the plan first proposed "worker"). `AlertHandler` in the server's code.
3. **Claiming by long poll**, not over the SSE stream.
4. **At most once, no automatic retries.**
5. **The second reference handler is a hosted-model bot** (`llm-analysis`, Grok as the
   example), not the Grok CLI in herdr.
6. **The agent is kept away from the Achtung server.** The reference handler blocks
   it; the spike shows how. If it can't be done cleanly on the VM, the user decides
   before phase 5 whether to accept that.
7. **Alerts may go to a public hosted model.** And a spike and an example with a
   **local model** are to be done for sure (phase 6).
8. **The agent gets its own read-only credentials**: a dedicated read-only kubeconfig
   and a Grafana Viewer token, before phase 1's spike runs on real alerts and before
   phase 5.
9. **The alert as Markdown lives in the SDK** (`agentReport`), tested against the same
   files as the Swift `AgentReport`.
10. **Everything in this repo**: `sdk/typescript`, `handlers/herdr-agent`,
    `handlers/llm-analysis`. The user's own profile and prompt stay in their dotfiles.
    Publishing to npm waits for `v1`.
11. **No automatic handover in v1.** Revisit after a month of pressing the button.
12. **A notification when a handover finishes**, on by default, only on the Mac that
    asked.
13. **Publishing the server image** is not part of this plan; the fake server covers
    plugin authors until then.
14. **Results in search** (ADR 0017): later.

Still open, each settled in its phase: whether a service outside a herdr pane may drive
herdr, and the exact restricted agent profile (phase 1); the npm scope and the
publishing workflow (phase 7).

---

## Progress

**Phase 2, the server: built** (2026-11-15). The protocol as built is described in
[`docs/handover-protocol.md`](../handover-protocol.md) and `api/openapi.yaml`; where they
differ from the sketch in section 2, they are right. The differences:

- The handlers' table is `alert_handlers`, not `handover_handlers`.
- `Handover` in the API is one flat shape with nullable fields (`claimedAt`,
  `deadlineAt`, `finishedAt`, `summary`, `body`, `error`), as `Occurrence` does with
  `endsAt`; the union by state is in the server's domain and will be in the client's.
- Registering the 51st handler is a 409.
- Reads settle the clock too, so a `GET` never shows a handover the clock has ended as
  still running.
- A claim reads the occurrence before it takes the handover, and takes it only if it is
  still requested.
- The protocol page already has the `curl` handler; it was run by hand against a real
  server. Running it in CI is still phase 3.
- The branch was rebased onto `main` on 2026-11-25, which has the change stream
  (ADR 0019); the migration is `0009_handovers`.
- Up to 100 claims may wait at once, not 20: with 50 handlers, 20 would leave most of
  them polling.
- A handler also counts as connected while it holds a running handover, since a lease
  (two minutes) is renewed less often than the 90 seconds.
- The `AchtungAPI` fixtures were not extended with `actions` and `handovers` (they are
  optional in the spec, and nothing could be run to check them). That moves to phase 4.
- Opening an alert's detail now takes the handovers lock for a moment, because reads
  settle the clock. Fine at this size; the thing to revisit if detail reads get slow.
- Not verified here: that the macOS packages still build against the new spec (no
  Swift on the machine this was built on). The Swift client generates only the
  `client` tag, so the handler routes don't reach it; the new client routes and the
  `handovers` change kind do.

Phase 1 (the spike on the VM) was not done first: it needs the agent's own read-only
credentials (decision 8). It is still due before phase 5.

## What stays from the earlier plan

From section 2 of `dead-mans-switch-and-agent-handover.md`:

- **Stays:** the decision that the VM pulls and is never pushed to, with its reasons;
  every guardrail; the herdr flow (workspace, `agent start`, `agent prompt`) and
  steering, now as `handlers/herdr-agent`; where Rex fits (not the transport, a link
  later); phase 1, the spike on the VM; the alternatives considered.
- **Changes:**
  - `investigations` (one feature's table and endpoints) becomes `handovers`, plus
    handlers and actions, so the investigation is one plugin among others.
  - The handler claims through a long poll instead of holding `/api/events` open and
    updating a row conditionally.
  - The agent no longer sends its result to the API itself; it writes a file and the
    handler posts it.
  - States: `requested | running | done | failed | timed_out` becomes `requested |
    running | succeeded | failed | cancelled | timed_out | expired`.
  - The change kind is `handovers`, not `investigations`.
  - "Where the handler lives" is answered: this repo, `handlers/herdr-agent`.
- **Still open from it:** the exact Claude profile and MCP servers (decisions 6 and 8 and
  the spike); results in search.

## Sources

1. GitHub Actions, self-hosted runners: the runner connects out over HTTPS and
   long-polls for jobs, no inbound connection needed (the long poll is described in the
   reference page):
   https://docs.github.com/en/actions/reference/runners/self-hosted-runners and
   https://docs.github.com/en/actions/concepts/runners/communicating-with-self-hosted-runners
2. Alertmanager `webhook_config` (payload `version: "4"`, timeout and retry):
   https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
3. Grafana IRM outgoing webhooks (trigger types, templates):
   https://grafana.com/docs/grafana-cloud/alerting-and-irm/irm/configure/integrations/webhooks/outgoing-webhooks/
4. PagerDuty custom incident actions and incident workflows:
   https://support.pagerduty.com/docs/custom-incident-actions,
   https://support.pagerduty.com/docs/incident-workflows; delivery deadlines and retries
   of v3 webhooks, from a third-party guide:
   https://hookdeck.com/webhooks/platforms/guide-to-pagerduty-webhooks-features-and-best-practices
5. Backstage backend system, plugins, modules and extension points:
   https://backstage.io/docs/backend-system/architecture/extension-points
6. Sentry integration platform and the alert rule action component:
   https://docs.sentry.io/organization/integrations/integration-platform/,
   https://docs.sentry.io/organization/integrations/integration-platform/ui-components/alert-rule-action
7. xAI REST API (OpenAI-compatible, `https://api.x.ai/v1`):
   https://docs.x.ai/developers/rest-api-reference
8. herdr CLI 0.9.5: `herdr --skill`, `herdr agent`, `herdr workspace`.
9. Achtung: ADR 0002 (no authentication), ADR 0019 (change stream),
   `macos/Packages/AchtungDomain/Sources/AchtungDomain/AgentReport.swift`.
