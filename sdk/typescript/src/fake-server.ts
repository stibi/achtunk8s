import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeHandovers } from "./fake-handovers.ts";
import type { Answer } from "./fake-rules.ts";
import type { Occurrence } from "./protocol.ts";

// A fake Achtung server for plugin authors: the handler API and the client's handover
// routes, in memory, with made-up alerts. Try a handler against it without Postgres or a
// cluster. It follows docs/handover-protocol.md; the conformance suite runs against it.

export interface FakeServerOptions {
  /** 0, the default, picks a free port. */
  readonly port?: number;
  /** The server's clock; tests move it to reach leases and deadlines. */
  readonly now?: () => Date;
  /** Each handler's token, by handler id. None: the handler API is open. */
  readonly tokens?: Readonly<Record<string, string>>;
  readonly occurrences?: readonly Occurrence[];
}

const at = "2026-11-15T09:30:00.000Z";

function sample(
  id: number,
  title: string,
  severity: Occurrence["severity"],
  pod: string,
): Occurrence {
  return {
    id,
    instance: "lab",
    channel: "ops",
    source: "alertmanager",
    sourceKey: `f1ngerpr1nt${id}`,
    status: "firing",
    severity,
    title,
    summary: `${title} in example-prod`,
    labels: { alertname: title, namespace: "example-prod", pod, severity },
    annotations: { summary: `${title} in example-prod` },
    links: [],
    startsAt: at,
    endsAt: null,
    firstReceivedAt: at,
    lastReceivedAt: at,
    lastEventAt: at,
    lastEventKind: "fired",
    notificationCount: 1,
    silencedUntil: null,
  };
}

/** Two made-up alerts: occurrence 1, a warning, and occurrence 2, critical. */
export const sampleOccurrences: readonly Occurrence[] = [
  sample(1, "KubePodCrashLooping", "warning", "api-7c9d8b6f5-x2k4q"),
  sample(2, "TargetDown", "critical", "exporter-0"),
];

async function jsonOf(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
  }
  return text === "" ? {} : JSON.parse(text);
}

type Route = (
  match: RegExpMatchArray,
  body: never,
  request: IncomingMessage,
) => Answer | Promise<Answer>;

function routesFor(
  handovers: FakeHandovers,
  claim: (handler: string, waitSeconds: number) => Promise<Answer>,
) {
  const id = (match: RegExpMatchArray) => Number(match[1]);
  const claimOf = (request: IncomingMessage) => {
    const header = request.headers["achtung-claim"];
    return typeof header === "string" ? header : undefined;
  };
  return [
    [
      "PUT",
      /^\/api\/handler\/v0\/handlers\/([^/]+)$/,
      (m, body) => handovers.register(m[1] ?? "", body),
    ],
    ["DELETE", /^\/api\/handler\/v0\/handlers\/([^/]+)$/, (m) => handovers.remove(m[1] ?? "")],
    [
      "POST",
      /^\/api\/handler\/v0\/handlers\/([^/]+)\/claim(?:\?wait=(\d+))?$/,
      (m) => claim(m[1] ?? "", Math.min(30, Number(m[2] ?? 10))),
    ],
    [
      "POST",
      /^\/api\/handler\/v0\/handovers\/(\d+)\/progress$/,
      (m, body: { message?: string }, request) =>
        handovers.progress(id(m), claimOf(request), body.message),
    ],
    [
      "POST",
      /^\/api\/handler\/v0\/handovers\/(\d+)\/result$/,
      (m, body, request) => handovers.result(id(m), claimOf(request), body),
    ],
    ["GET", /^\/api\/occurrences\/(\d+)$/, (m) => handovers.detail(id(m))],
    [
      "POST",
      /^\/api\/occurrences\/(\d+)\/handovers$/,
      (m, body: { handler?: string; action?: string }) =>
        handovers.create(id(m), body.handler ?? "", body.action ?? ""),
    ],
    ["GET", /^\/api\/handovers\/(\d+)$/, (m) => handovers.get(id(m))],
    ["POST", /^\/api\/handovers\/(\d+)\/cancel$/, (m) => handovers.cancel(id(m))],
  ] as const satisfies readonly (readonly [string, RegExp, Route])[];
}

/** Why the request may not use the handler API as it does; null when it may. */
function forbiddenBy(
  tokens: FakeServerOptions["tokens"],
  request: IncomingMessage,
  url: string,
): Answer | null {
  if (tokens === undefined || !url.startsWith("/api/handler/")) {
    return null;
  }
  const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  const handler = Object.entries(tokens).find(([, token]) => token === given)?.[0];
  if (handler === undefined) {
    return { status: 401, body: { error: "A handler token is required" } };
  }
  const named = /\/handlers\/([^/?]+)/.exec(url)?.[1];
  return named === undefined || named === handler
    ? null
    : { status: 403, body: { error: "The token belongs to another handler" } };
}

export async function startFakeServer(options: FakeServerOptions = {}) {
  const handovers = new FakeHandovers(
    options.occurrences ?? sampleOccurrences,
    options.now ?? (() => new Date()),
  );
  const tokens = options.tokens;
  const wake: (() => void)[] = [];
  const changed = () => {
    for (const resume of wake.splice(0)) {
      resume();
    }
  };

  /** The handler's next handover, waiting up to `waitSeconds` for one. */
  const claim = async (handler: string, waitSeconds: number): Promise<Answer> => {
    const until = Date.now() + waitSeconds * 1000;
    for (;;) {
      const answer = handovers.claim(handler);
      const left = until - Date.now();
      if (answer.status !== 204 || left <= 0) {
        return answer;
      }
      await new Promise<void>((resolve) => {
        wake.push(resolve);
        setTimeout(resolve, left).unref();
      });
    }
  };

  const routes = routesFor(handovers, claim);
  const forbidden = (request: IncomingMessage, url: string) => forbiddenBy(tokens, request, url);

  const respond = async (request: IncomingMessage): Promise<Answer> => {
    const url = request.url ?? "";
    for (const [method, pattern, route] of routes) {
      const match = request.method === method ? url.match(pattern) : null;
      if (match !== null) {
        return (
          forbidden(request, url) ?? (await route(match, (await jsonOf(request)) as never, request))
        );
      }
    }
    return { status: 404, body: { error: "The fake server has no such route" } };
  };

  const server = createServer((request, response) => {
    void respond(request)
      .catch((): Answer => ({ status: 400, body: { error: "body/ not valid JSON" } }))
      .then(({ status, body }) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body === null ? undefined : JSON.stringify(body));
        if (request.method !== "GET") {
          changed();
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        changed();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
