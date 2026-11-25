# LLM analysis: an Achtung handler that asks a language model

A plugin for [Achtung](../../README.md), written with the
[handover SDK](../../sdk/typescript/README.md). It adds a button to every alert, "Explain
with a Model". Pressing it sends the alert to a language model, and the model's answer
shows in the alert: what it most likely means, likely causes, where to look first.

It is the simple kind of handler: one question per alert, a few seconds, no tools. The
model reads the alert and nothing else. It investigates nothing, and its answer says so.
For an agent that looks into your systems, see the plan's other handler,
`handlers/herdr-agent`.

It speaks the OpenAI-compatible chat API (`POST <base>/chat/completions`), so the same
handler works with a hosted model or one on your own machine.

## Before you point it at real alerts

**The alert leaves your network when the model is hosted.** Labels and annotations carry
hostnames, namespaces and other topology. That is your decision per deployment:

- `DROP_LABELS` and `DROP_ANNOTATIONS` name what is never sent, e.g.
  `DROP_LABELS=instance,pod,node`.
- A local model (below) sends nothing out.

Alert text is untrusted: other systems write it. The handler sends it under fixed
instructions that say so, fenced as data. A model can still be talked round, so treat
the answer as a suggestion. It can't do anything: the handler has no tools and no access.

## Run it

It needs Node 24 and this repository (the SDK isn't published yet).

```bash
pnpm install
ACHTUNG_URL=http://achtung.example \
ACHTUNG_HANDLER_TOKEN=… \
LLM_BASE_URL=https://api.x.ai/v1 LLM_API_KEY=… LLM_MODEL=<a model of that API> \
  pnpm --dir handlers/llm-analysis start
```

| Variable                          |                                                                |
| --------------------------------- | -------------------------------------------------------------- |
| `ACHTUNG_URL`                     | Required. The Achtung server.                                  |
| `ACHTUNG_HANDLER_ID`              | This handler's id on the server; `llm-analysis` when left out. |
| `ACHTUNG_HANDLER_TOKEN`           | Its token, when the server sets `HANDLER_TOKENS`.              |
| `LLM_BASE_URL`                    | Required. The API's base, ending before `/chat/completions`.   |
| `LLM_API_KEY`                     | The API's key; left out for a local model that needs none.     |
| `LLM_MODEL`                       | Required. The model's name in that API.                        |
| `LLM_TIMEOUT_SECONDS`             | How long one answer may take; 120.                             |
| `ACTION_TITLE`                    | What the button says; "Explain with a Model".                  |
| `MAX_CONCURRENT`                  | Alerts answered at once; 4.                                    |
| `DROP_LABELS`, `DROP_ANNOTATIONS` | Comma-separated names never sent to the model.                 |

On the server, add the handler to `HANDLER_TOKENS` (`{"llm-analysis": "<token>"}`).

### With a local model

Any server with the OpenAI-compatible API works; nothing leaves the machine. With
[Ollama](https://ollama.com):

```bash
ollama pull llama3.2
ACHTUNG_URL=http://achtung.example ACHTUNG_HANDLER_TOKEN=… \
LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_MODEL=llama3.2 \
ACTION_TITLE="Explain with a Local Model" LLM_TIMEOUT_SECONDS=300 MAX_CONCURRENT=1 \
  pnpm --dir handlers/llm-analysis start
```

A small local model is slower and vaguer than a hosted one; one alert at a time and a
longer timeout suit it. **This setup has not been run yet** (the machine this was built
on has no local model server); it differs from the tested path only in the address and
the missing key.

### Try it without an Achtung server

```bash
pnpm --dir sdk/typescript run dev        # a fake Achtung on :8790, with two made-up alerts
ACHTUNG_URL=http://127.0.0.1:8790 LLM_BASE_URL=… LLM_MODEL=… pnpm --dir handlers/llm-analysis start
curl -X POST http://127.0.0.1:8790/api/occurrences/1/handovers \
  -H 'content-type: application/json' -d '{"handler": "llm-analysis", "action": "explain"}'
curl http://127.0.0.1:8790/api/handovers/1
```

### As a container

Built from the repository's root; it runs as a non-root user with a read-only filesystem.

```bash
docker build -f handlers/llm-analysis/Dockerfile -t achtung-llm-analysis .
```

[`deploy/example.yaml`](deploy/example.yaml) runs it next to Achtung in Kubernetes, with
its token and the model's key from a Secret. It only connects out, to Achtung and to the
model's API; it needs no Service and no ingress.

## Working on it

```bash
pnpm --dir handlers/llm-analysis run check   # typecheck, lint, dead code, duplication, tests
```

The tests run it against the SDK's fake Achtung server and a fake model API.
