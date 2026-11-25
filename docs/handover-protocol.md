# The handover protocol

How a plugin takes alerts that are handed over to it. A plugin is a **handler**: a
program of yours that connects out to the Achtung server, says which **actions** it
offers, takes the **handovers** for them and reports back. Why it is built this way:
[ADR 0022](adr/0022-handover-to-handlers.md), [ADR 0023](adr/0023-handler-token.md).

The exact shapes are in [`api/openapi.yaml`](../api/openapi.yaml), under the `handler`
tag (what a handler calls) and the `client` tag (what the app calls). This page says how
the calls fit together.

**Status: `v0`.** The handler API lives under `/api/handler/v0/` and may still change.
It is frozen as `v1` once two handlers of different kinds are built against it. From
then on it only grows: new optional request fields, new response fields, new routes. A
handler must ignore fields it doesn't know.

In TypeScript, the SDK in [`sdk/typescript`](../sdk/typescript/README.md) writes the loop
below for you, and brings a fake server to try and test a handler against. In any other
language, this page and the `curl` handler at its end are what you need.

## The loop

```
PUT  /api/handler/v0/handlers/{handler}              register: name, version, actions
POST /api/handler/v0/handlers/{handler}/claim?wait=10   200: a handover, yours now · 204: nothing
POST /api/handler/v0/handovers/{id}/progress         renew the lease, optional status line
POST /api/handler/v0/handovers/{id}/result           succeeded or failed: the end
```

1. **Register** at startup, again when your actions change, and after a claim answered
   404 (the server forgot you). An action has an id, a title (the button), a
   description (its help text), a timeout (60 to 3600 seconds, default 900) and
   `appliesTo`: instances, severities and exact labels, all of which must match; leave
   it out to offer the action on every alert.
2. **Claim in a loop.** The request is held for up to `wait` seconds (default 10, at
   most 30; over 10 needs a gateway that doesn't cut requests off at 15 seconds). 200
   is a handover; 204 means ask again; 503 means too many claims are waiting (100), so pause
   first. Every claim also tells the server you are connected. Stop claiming for 90
   seconds while idle and your buttons are disabled; a handler that holds a running
   handover counts as connected.
3. **A claimed handover is yours alone and is given out once.** The answer carries the
   occurrence, its events and its other occurrences as `GET /api/occurrences/{id}`
   returns them, a `claimToken`, `leaseSeconds` (120) and `deadlineAt`. If you crash
   after the claim, the handover fails two minutes later; it is not handed out again.
4. **Call progress at least every `leaseSeconds`**, with the `Achtung-Claim: <claimToken>`
   header. A `message` (up to 500 characters) is shown to the person waiting; without
   one the call only renews the lease. The answer's `state` tells you whether to go on:
   anything but `running` (`cancelled`, `timed_out`, `failed`) means stop.
5. **Post the result** with the same header: `{"outcome": "succeeded", "summary",
   "body", "links"}` or `{"outcome": "failed", "error"}`. The summary is one line of
   plain text (300 characters), the body is Markdown (64 KiB), links are up to 10 `http`
   or `https` URLs, without credentials, with a title. Text with a NUL character or a
   broken surrogate pair is a 400, so clean what an agent or a command printed. Sending the same result again is answered as before; a
   409 means the handover ended another way first.

## The states of a handover

```
requested ──claim──▶ running ──result──▶ succeeded | failed
    │                   │
    │ cancel            ├── cancel ──────▶ cancelled
    ▼                   ├── lease ran out ▶ failed ("handler lost")
 cancelled              └── deadline ─────▶ timed_out
    │
    └── nobody claimed for 10 minutes ───▶ expired
```

- A person creates a handover with the action's button (`POST
  /api/occurrences/{id}/handovers`). While one of that action is requested or running
  for the occurrence, asking again returns that one.
- The server judges leases, deadlines and expiry against the clock on every call, so
  they are exact. Nothing is retried automatically: a retry is a person asking again.
- At most 20 handovers are requested or running on a server, 50 handlers are
  registered, and a handover keeps 200 progress lines.

## Authentication

When the server sets `HANDLER_TOKENS` (a JSON object of handler id → token), every
handler route needs `Authorization: Bearer <token>`, and a handler can act only under
its own id: 401 without a valid token, 403 with another handler's. When it isn't set,
the handler routes are open, like the rest of Achtung (ADR 0002), and the server logs a
warning when a handler registers. Set it for anything but a trial.

## Rules for handler authors

- **Alert labels and annotations are untrusted text**, written by many systems. Never
  put them on a command line or evaluate them. If you prompt a model with them, use a
  fixed prompt and pass the alert fenced as data.
- **A handler that acts on production is bounded by its credentials and its network,
  not by its prompt.** Give an agent read-only credentials. Keep it from reaching the
  Achtung server itself, which is open and can silence alerts. What it may read it can
  also send out, so keep secrets out of its reach.
- **Your result is shown to everyone who can reach the server.** No secret values in
  it. It is rendered as text; remote images are not loaded and links open on a click.
- **Sending alerts to a hosted model sends hostnames and topology out of your network.**
  Make that a choice of whoever runs the handler, and let them drop labels first.
- Keep your own secrets (model keys, cluster credentials). The server stores none for
  you and hands you nothing of its configuration.

## A handler in curl

The whole protocol in a shell script, with `curl` and `jq`. It offers one action and
answers each handover with the alert's title.

```bash
#!/usr/bin/env bash
set -euo pipefail
server="${ACHTUNG_URL:-http://127.0.0.1:8080}"
api="$server/api/handler/v0"
auth=(-H "authorization: Bearer ${ACHTUNG_HANDLER_TOKEN:-}")
json=(-H "content-type: application/json")
claimed="$(mktemp)"

register() {
  curl -fsS -X PUT "$api/handlers/curl-handler" "${auth[@]}" "${json[@]}" -d '{
    "name": "curl handler", "version": "0.1.0",
    "actions": [{"id": "echo", "title": "Echo the Alert", "timeoutSeconds": 120}]
  }' >/dev/null
}

register
while true; do
  # Held for up to 10 seconds; 204 with an empty body when nothing waits.
  status=$(curl -sS -o "$claimed" -w '%{http_code}' -X POST "${auth[@]}" \
    "$api/handlers/curl-handler/claim?wait=10") || status=000
  case "$status" in
    200) ;;
    204) continue ;;
    404) register; continue ;;          # the server forgot this handler
    *) sleep 5; continue ;;             # 503 or an outage: back off
  esac
  id=$(jq -r .id "$claimed")
  claim=(-H "achtung-claim: $(jq -r .claimToken "$claimed")")
  title=$(jq -r .occurrence.title "$claimed")   # untrusted text: never eval it

  # Renews the lease and tells the client what is going on. Not "running": stop.
  state=$(curl -fsS -X POST "$api/handovers/$id/progress" "${auth[@]}" "${claim[@]}" \
    "${json[@]}" -d '{"message": "looking at it"}' | jq -r .state)
  [ "$state" = running ] || continue

  jq -n --arg title "$title" '{outcome: "succeeded", summary: ("Saw " + $title),
    body: ("The alert **" + $title + "** was handed over."), links: []}' |
    curl -fsS -X POST "$api/handovers/$id/result" "${auth[@]}" "${claim[@]}" "${json[@]}" \
      -d @- >/dev/null
done
```

Try it: hand an alert over with

```bash
curl -X POST "$ACHTUNG_URL/api/occurrences/1/handovers" -H 'content-type: application/json' \
  -d '{"handler": "curl-handler", "action": "echo"}'
```

and read the result from `GET /api/handovers/1`, or from the occurrence's detail, which
also lists the actions offered for it.
