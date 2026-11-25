// Shared by the handover tests in test/http/ (ADR 0022).
import type { FastifyInstance } from "fastify";
import { crashLoop, deliver, getJson, targetDown } from "./api.ts";
import { appWithDatabase, type TestAppOptions } from "./app.ts";

/** A clock the tests move; handovers judge leases, deadlines and expiry by it. */
function testClock(start: string) {
  let current = new Date(start);
  return {
    now: () => current,
    advance: (seconds: number) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

/** A handler as it registers itself: one action, for every alert, with a 10-minute timeout. */
export const agent = {
  name: "herdr agent",
  version: "0.1.0",
  actions: [
    {
      id: "investigate",
      title: "Investigate with Agent",
      description: "Starts an agent, read-only.",
      timeoutSeconds: 600,
    },
  ],
};

/** The app with two firing alerts, a warning (crashLoop) and a critical one (targetDown). */
export async function handoverApp(options: Omit<TestAppOptions, "now"> = {}) {
  const clock = testClock("2026-11-15T10:00:00Z");
  const { app, services } = await appWithDatabase({ ...options, now: clock.now });
  await deliver(services, [crashLoop, targetDown], "2026-11-15T09:30:00Z", "ops", "lab");
  const { body } = await getJson(app, "/api/occurrences");
  const id = (title: string): number =>
    body.occurrences.find((occurrence: { title: string }) => occurrence.title === title).id;
  return {
    app,
    services,
    clock,
    crashLoopId: id("KubePodCrashLooping"),
    targetDownId: id("TargetDown"),
  };
}

type Headers = Record<string, string>;

export function register(
  app: FastifyInstance,
  handler = "herdr-agent",
  body: unknown = agent,
  headers: Headers = {},
) {
  return app.inject({
    method: "PUT",
    url: `/api/handler/v0/handlers/${handler}`,
    body: body as object,
    headers,
  });
}

export function handOver(
  app: FastifyInstance,
  occurrenceId: number,
  handler = "herdr-agent",
  action = "investigate",
) {
  return app.inject({
    method: "POST",
    url: `/api/occurrences/${occurrenceId}/handovers`,
    body: { handler, action },
  });
}

export function cancel(app: FastifyInstance, id: number) {
  return app.inject({ method: "POST", url: `/api/handovers/${id}/cancel` });
}

export function claim(app: FastifyInstance, handler = "herdr-agent", headers: Headers = {}) {
  return app.inject({
    method: "POST",
    url: `/api/handler/v0/handlers/${handler}/claim?wait=0`,
    headers,
  });
}

export function progress(
  app: FastifyInstance,
  id: number,
  claimToken: string | null,
  message?: string,
  headers: Headers = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/handler/v0/handovers/${id}/progress`,
    headers: { ...headers, ...(claimToken === null ? {} : { "achtung-claim": claimToken }) },
    ...(message === undefined ? {} : { body: { message } }),
  });
}

export function answer(app: FastifyInstance, id: number, claimToken: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/handler/v0/handovers/${id}/result`,
    headers: { "achtung-claim": claimToken },
    body: body as object,
  });
}

export const findings = {
  outcome: "succeeded",
  summary: "The api container is out of memory",
  body: "## Findings\n\nThe pod was OOM-killed four times in the last hour.",
  links: [{ title: "Memory dashboard", url: "https://grafana.example.com/d/memory" }],
};

/** A registered handler holding a running handover of the crashLoop alert. */
export async function claimedHandover(options: Omit<TestAppOptions, "now"> = {}) {
  const context = await handoverApp(options);
  await register(context.app);
  await handOver(context.app, context.crashLoopId);
  const claimed = (await claim(context.app)).json();
  return { ...context, id: claimed.id as number, claimToken: claimed.claimToken as string };
}

export async function stateOf(app: FastifyInstance, id: number): Promise<string> {
  return (await getJson(app, `/api/handovers/${id}`)).body.state;
}
