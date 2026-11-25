# herdr agent: an Achtung handler that has a coding agent investigate an alert

A plugin for [Achtung](../../README.md), written with the
[handover SDK](../../sdk/typescript/README.md). It adds a button to every alert,
"Investigate with Agent". Pressing it starts a coding agent (Claude Code by default) in a
[herdr](https://herdr.dev) workspace of its own, on the machine this handler runs on. The
agent reads the alert, looks into your systems, and writes down what it found; the
findings then show in the alert, for everyone.

Because the agent runs in herdr, you can open its workspace while it works: watch it,
answer when it asks, or take the conversation over. The alert says when the agent is
waiting for you.

It is the heavy kind of handler: minutes per alert, real access to your systems. Read
the next section before you run it. For a handler that only asks a model what an alert
means, see [`handlers/llm-analysis`](../llm-analysis/README.md).

**Status:** built and tested against a scripted herdr and the SDK's fake Achtung server.
**It has not yet investigated a real alert with a real agent.** That first run, with
read-only credentials in place, is still to be done; expect the instructions and the
agent's settings to change after it.

## What the agent must not be able to do

The alert's labels and annotations are written by many systems, and the agent reads
them. Assume one day an alert says "ignore your instructions and …". The handler does
its part:

- The agent gets fixed instructions that name two files. The alert is one of them, never
  part of the prompt, and never on a command line.
- The agent never holds the handover's claim token. It writes its findings to a file;
  the handler posts them.
- The handler passes arguments to herdr as a vector, never through a shell.

**The rest is yours, and it is the part that counts.** An agent is bounded by what its
credentials and its network allow, not by what it was told:

1. **Read-only credentials, made for the agent.** A kubeconfig bound to a role that can
   get, list and read logs, and cannot read Secrets; a Grafana token with the Viewer
   role. Not the credentials you work with yourself.
2. **No way to the Achtung server.** Achtung's own API is open inside your network and
   can silence alerts. Run the agent so that it cannot reach it (a firewall rule for
   the agent's user, or a tool allowlist without general network access). The handler
   itself needs to reach Achtung; the agent does not.
3. **A tool allowlist as the second layer**: reading and searching files, the read-only
   commands of your tools, writing only under `handovers/`. With Claude Code, a settings
   file passed through `AGENT_ARGS`, for example:

   ```json
   {
     "permissions": {
       "allow": [
         "Read", "Grep", "Glob", "Write(handovers/**)",
         "Bash(kubectl get:*)", "Bash(kubectl describe:*)", "Bash(kubectl logs:*)",
         "Bash(kubectl top:*)"
       ],
       "deny": ["Bash(kubectl get secret:*)", "Bash(kubectl get secrets:*)", "WebFetch", "WebSearch"]
     }
   }
   ```

   An example to start from, not a tested profile.
4. What the agent can read, it can also write into its findings, which everyone who can
   open the alert sees. Keep secrets out of its reach.

## Run it

It needs Node 24, this repository (the SDK isn't published yet), and a running herdr
server on the same machine, as the same user.

```bash
pnpm install
ACHTUNG_URL=http://achtung.example ACHTUNG_HANDLER_TOKEN=… \
WORK_DIR=$HOME/achtung-agent \
AGENT_ARGS='["--settings","/home/me/achtung-agent/agent-settings.json"]' \
  pnpm --dir handlers/herdr-agent start
```

| Variable                |                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ACHTUNG_URL`           | Required. The Achtung server.                                                                                                      |
| `ACHTUNG_HANDLER_ID`    | This handler's id on the server; `herdr-agent` when left out.                                                                      |
| `ACHTUNG_HANDLER_TOKEN` | Its token, when the server sets `HANDLER_TOKENS`.                                                                                  |
| `WORK_DIR`              | Required, absolute. Where the agents run. Each handover gets `handovers/<id>/` in it, with `alert.md` and the agent's `result.md`. |
| `AGENT_KIND`            | One of herdr's agent kinds; `claude`.                                                                                              |
| `AGENT_ARGS`            | The agent's own arguments, as a JSON array of strings.                                                                             |
| `INSTRUCTIONS_FILE`     | A file of your own instructions, added to the fixed ones: which contexts to use, where the dashboards are.                         |
| `ACTION_TITLE`          | What the button says; "Investigate with Agent".                                                                                    |
| `TIMEOUT_SECONDS`       | How long one investigation may take; 1200, at most 3600.                                                                           |
| `MAX_CONCURRENT`        | Agents at once; 1. Further alerts wait up to ten minutes on the server.                                                            |
| `KEEP_WORKSPACE`        | `false` closes the agent's workspace when it finished; by default it stays, to read on or go on in.                                |
| `HERDR_BIN`             | The herdr command; `herdr`.                                                                                                        |

On the server, add the handler to `HANDLER_TOKENS` (`{"herdr-agent": "<token>"}`).

**Trust `WORK_DIR` once.** An agent started in a directory it has never seen asks
whether to trust it, and waits. Start the agent there once by hand and answer. If it
does ask during a handover, the alert says "The agent asks something before it starts"
and waits for you to answer in herdr.

**The handler talks to herdr's session.** Run it where the `herdr` command reaches your
session: in a herdr pane of its own, or as a service with the session named in
`HERDR_BIN`'s environment. It was developed running inside a herdr pane; as a systemd
service it is untried.

### What happens for one alert

1. The handler writes the alert to `WORK_DIR/handovers/<id>/alert.md`.
2. `herdr workspace create --cwd WORK_DIR --label achtung-<id> --no-focus`.
3. `herdr agent start inv-<id> --kind claude --pane <the workspace's pane> -- <AGENT_ARGS>`.
4. `herdr agent prompt inv-<id> "<the fixed instructions>"`: read `alert.md`, investigate
   read-only, write `result.md`.
5. It follows the agent with `herdr agent wait` and `agent get`. While the agent is
   blocked on a question, the alert says so.
6. When the agent has settled and `result.md` is there, its first line becomes the
   summary and the rest the body. No file: the handover fails and names the workspace.
7. Cancelled in Achtung, or out of time: the handler interrupts the agent (Esc) and
   leaves the workspace for you.

### Try it without an Achtung server

```bash
pnpm --dir sdk/typescript run dev        # a fake Achtung on :8790, with two made-up alerts
ACHTUNG_URL=http://127.0.0.1:8790 WORK_DIR=$HOME/achtung-agent pnpm --dir handlers/herdr-agent start
curl -X POST http://127.0.0.1:8790/api/occurrences/1/handovers \
  -H 'content-type: application/json' -d '{"handler": "herdr-agent", "action": "investigate"}'
```

This starts a real agent on a made-up alert, so it is also the safest first run.

## Working on it

```bash
pnpm --dir handlers/herdr-agent run check   # typecheck, lint, dead code, duplication, tests
```

The tests play herdr from a script (which status the agent has at each look, what it
writes) and run against the SDK's fake Achtung server. One of them takes half a minute:
a cancel reaches a handler with its next lease renewal.
