import { strict as assert } from "node:assert";
import type { ClaimedHandover, HandoverLink, HandoverState } from "../src/protocol.ts";

/** A server to hold to the protocol: the real one, the fake one, or yours. */
export interface Target {
  /** Its base URL, e.g. `http://127.0.0.1:8080`. */
  readonly url: string;
  /** An occurrence that fires on it, with severity `warning`. */
  readonly occurrenceId: number;
  /** Moves the server's clock forward, to reach leases, deadlines and expiry. */
  advance(seconds: number): void | Promise<void>;
}

/** A reply whose body is `T` when the call went as the scenario expects. */
export interface Reply<T> {
  readonly status: number;
  readonly body: T;
}

/** A handover as the client routes show it: what the scenarios look at. */
export interface HandoverView {
  readonly id: number;
  readonly state: HandoverState;
  readonly summary: string | null;
  readonly body: string | null;
  readonly links: readonly HandoverLink[];
  readonly error: string | null;
  readonly progress: readonly { readonly message: string }[];
}

export interface DetailView {
  readonly actions: readonly {
    readonly handler: string;
    readonly handlerName: string;
    readonly action: string;
    readonly title: string;
    readonly description: string;
    readonly available: boolean;
  }[];
}

/** One HTTP call to the target, as JSON. */
async function call<T = unknown>(
  target: Target,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const response = await fetch(`${target.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

export const handler = "conformance";
const api = "/api/handler/v0";

export const registration = {
  name: "Conformance handler",
  version: "1.0.0",
  actions: [{ id: "look", title: "Look at It", description: "Looks.", timeoutSeconds: 600 }],
};

export const register = (target: Target, body: unknown = registration) =>
  call(target, "PUT", `${api}/handlers/${handler}`, body);

export const handOver = (target: Target, action = "look") =>
  call<HandoverView>(target, "POST", `/api/occurrences/${target.occurrenceId}/handovers`, {
    handler,
    action,
  });

export const detail = (target: Target) =>
  call<DetailView>(target, "GET", `/api/occurrences/${target.occurrenceId}`);

export const claim = (target: Target, wait = 0) =>
  call<ClaimedHandover>(target, "POST", `${api}/handlers/${handler}/claim?wait=${wait}`);

export const progress = (target: Target, id: number, claimToken: string, message?: string) =>
  call<{ state: HandoverState; leaseSeconds: number }>(
    target,
    "POST",
    `${api}/handovers/${id}/progress`,
    message === undefined ? {} : { message },
    {
      "achtung-claim": claimToken,
    },
  );

export const answer = (target: Target, id: number, claimToken: string, result: unknown) =>
  call<HandoverView>(target, "POST", `${api}/handovers/${id}/result`, result, {
    "achtung-claim": claimToken,
  });

export const read = (target: Target, id: number) =>
  call<HandoverView>(target, "GET", `/api/handovers/${id}`);

export const cancel = (target: Target, id: number) =>
  call<HandoverView>(target, "POST", `/api/handovers/${id}/cancel`);

export const findings = {
  outcome: "succeeded",
  summary: "The api container is out of memory",
  body: "## Findings\n\nOOM-killed four times in the last hour.",
  links: [{ title: "Memory dashboard", url: "https://grafana.example.com/d/memory" }],
};

/** A registered handler holding a running handover. */
export async function claimed(target: Target): Promise<{ id: number; claimToken: string }> {
  assert.equal((await register(target)).status, 200);
  assert.equal((await handOver(target)).status, 201);
  const reply = await claim(target);
  assert.equal(reply.status, 200);
  return { id: reply.body.id, claimToken: reply.body.claimToken };
}
