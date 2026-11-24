import { describe, expect, it } from "vitest";
import type { MetricsBackend } from "../../src/services/metrics.ts";
import { unreachableUrl } from "../alertmanager-stub.ts";
import { crashLoop, deliver, getJson, targetDown } from "../api.ts";
import { appWithDatabase, type TestAppOptions } from "../app.ts";
import { type PrometheusStub, startPrometheusStub } from "../prometheus-stub.ts";

// crashLoop fires at 08:15:30 for the pod example-prod/api-7c9d8b6f5-x2k4q; targetDown names
// no pod. Both are delivered to the instance "lab".
const now = new Date("2026-10-13T09:00:20Z");
const windowStart = Date.parse("2026-10-13T06:00:00Z") / 1000;

function backendFor(
  stub: PrometheusStub,
  extra: Partial<MetricsBackend> = {},
): Record<string, MetricsBackend> {
  return { lab: { url: stub.url, auth: null, headers: {}, matchers: {}, ...extra } };
}

async function appWithAlerts(options: TestAppOptions = {}) {
  const { app, services } = await appWithDatabase({ now: () => now, ...options });
  await deliver(services, [crashLoop, targetDown], "2026-10-13T08:30:00Z", "ops", "lab");
  const { body } = await getJson(app, "/api/occurrences");
  const idOf = (title: string) =>
    body.occurrences.find((occurrence: { title: string }) => occurrence.title === title)
      .id as number;
  return { app, pod: idOf(crashLoop.title), noPod: idOf(targetDown.title) };
}

/** A minute's samples from the window's start. */
const samples = (...values: string[]): [number, string][] =>
  values.map((value, index) => [windowStart + index * 60, value]);

function answerLikeKubernetes(stub: PrometheusStub) {
  stub.answer = (promql) => {
    if (promql.includes("container_cpu_usage_seconds_total")) {
      return [
        { metric: { container: "api" }, values: samples("0.25", "0.5", "NaN", "0.75") },
        { metric: { container: "proxy" }, values: samples("0.01", "0.02") },
      ];
    }
    if (promql.includes("kube_pod_container_resource_requests")) {
      return [{ metric: { container: "api" }, values: samples("0.5", "0.5") }];
    }
    return [{ metric: { container: "api" }, values: samples("1", "1") }];
  };
}

const graphUrl = (id: number) => `/api/occurrences/${id}/metrics/pod-cpu`;

describe("GET /api/occurrences/{id} metricPanels", () => {
  it("offers pod-cpu for an alert about a pod on an instance with a metrics backend", async () => {
    const stub = await startPrometheusStub();
    const { app, pod, noPod } = await appWithAlerts({ metrics: backendFor(stub) });

    expect((await getJson(app, `/api/occurrences/${pod}`)).body.metricPanels).toEqual(["pod-cpu"]);
    expect((await getJson(app, `/api/occurrences/${noPod}`)).body.metricPanels).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it("offers nothing on an instance without a metrics backend", async () => {
    const { app, pod } = await appWithAlerts();

    expect((await getJson(app, `/api/occurrences/${pod}`)).body.metricPanels).toEqual([]);
  });
});

describe("GET /api/occurrences/{id}/metrics/pod-cpu", () => {
  it("answers each container's CPU usage, request and limit over the last 3 hours", async () => {
    const stub = await startPrometheusStub();
    answerLikeKubernetes(stub);
    const { app, pod } = await appWithAlerts({ metrics: backendFor(stub) });

    const { status, body } = await getJson(app, graphUrl(pod));

    expect(status).toBe(200);
    const at = (minutes: number) => new Date((windowStart + minutes * 60) * 1000).toISOString();
    expect(body).toEqual({
      panel: "pod-cpu",
      unit: "cores",
      from: "2026-10-13T06:00:00.000Z",
      to: "2026-10-13T09:00:00.000Z",
      stepSeconds: 60,
      series: [
        {
          name: "api",
          role: "usage",
          // NaN is no value: a gap.
          points: [
            { at: at(0), value: 0.25 },
            { at: at(1), value: 0.5 },
            { at: at(3), value: 0.75 },
          ],
        },
        {
          name: "api",
          role: "request",
          points: [
            { at: at(0), value: 0.5 },
            { at: at(1), value: 0.5 },
          ],
        },
        {
          name: "api",
          role: "limit",
          points: [
            { at: at(0), value: 1 },
            { at: at(1), value: 1 },
          ],
        },
        {
          name: "proxy",
          role: "usage",
          points: [
            { at: at(0), value: 0.01 },
            { at: at(1), value: 0.02 },
          ],
        },
      ],
      truncated: false,
    });
    expect(stub.requests.map((request) => request.path)).toEqual(
      Array(3).fill("/prometheus/api/v1/query_range"),
    );
    expect(Object.fromEntries(stub.requests[0]?.query ?? [])).toMatchObject({
      start: String(windowStart),
      end: String(windowStart + 3 * 3600),
      step: "60",
    });
  });

  it("builds the query from the alert's labels and the configured matchers, and sends the configured auth and headers", async () => {
    const stub = await startPrometheusStub();
    const { app, pod } = await appWithAlerts({
      metrics: backendFor(stub, {
        auth: { kind: "bearer", token: "t0ken" },
        headers: { "X-Scope-OrgID": "tenant-1" },
        matchers: { cluster: "lab" },
      }),
    });

    await getJson(app, graphUrl(pod));

    const usage = stub.requests.find((request) =>
      request.query.get("query")?.includes("container_cpu_usage_seconds_total"),
    );
    expect(usage?.query.get("query")).toBe(
      'sum by (container) (rate(container_cpu_usage_seconds_total{cluster="lab", namespace="example-prod", pod="api-7c9d8b6f5-x2k4q", container!="", image!=""}[180s]))',
    );
    expect(usage?.headers).toMatchObject({
      authorization: "Bearer t0ken",
      "x-scope-orgid": "tenant-1",
    });
  });

  it("sends basic auth", async () => {
    const stub = await startPrometheusStub();
    const { app, pod } = await appWithAlerts({
      metrics: backendFor(stub, { auth: { kind: "basic", username: "achtung", password: "pw" } }),
    });

    await getJson(app, graphUrl(pod));

    expect(stub.requests[0]?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("achtung:pw").toString("base64")}`,
    );
  });

  it("answers no series when the backend has none for the pod", async () => {
    const stub = await startPrometheusStub();
    const { app, pod } = await appWithAlerts({ metrics: backendFor(stub) });

    const { status, body } = await getJson(app, graphUrl(pod));

    expect(status).toBe(200);
    expect(body.series).toEqual([]);
  });

  it("asks the backend once for many clients within 30 seconds", async () => {
    const stub = await startPrometheusStub();
    const { app, pod } = await appWithAlerts({ metrics: backendFor(stub) });

    await Promise.all([getJson(app, graphUrl(pod)), getJson(app, graphUrl(pod))]);
    await getJson(app, graphUrl(pod));

    expect(stub.requests).toHaveLength(3);
  });

  it("asks again once the answer is 30 seconds old", async () => {
    const stub = await startPrometheusStub();
    let clock = now;
    const { app, pod } = await appWithAlerts({ metrics: backendFor(stub), now: () => clock });

    await getJson(app, graphUrl(pod));
    clock = new Date(now.getTime() + 29_000);
    await getJson(app, graphUrl(pod));
    clock = new Date(now.getTime() + 31_000);
    await getJson(app, graphUrl(pod));

    expect(stub.requests).toHaveLength(6);
  });

  it.each([
    ["an alert without a pod", "noPod" as const, true],
    ["an instance without a metrics backend", "pod" as const, false],
  ])("answers 404 for %s", async (_, which, configured) => {
    const stub = await startPrometheusStub();
    const options = configured ? { metrics: backendFor(stub) } : {};
    const ids = await appWithAlerts(options);

    const { status, body } = await getJson(ids.app, graphUrl(ids[which]));

    expect(status).toBe(404);
    expect(body).toEqual({ error: "The occurrence has no such graph" });
    expect(stub.requests).toEqual([]);
  });

  it("answers 404 for an occurrence it doesn't have, and 400 for a panel it doesn't know", async () => {
    const { app, pod } = await appWithAlerts();

    expect((await getJson(app, graphUrl(pod + 1000))).status).toBe(404);
    expect((await getJson(app, `/api/occurrences/${pod}/metrics/pod-disk`)).status).toBe(400);
  });

  it("answers 502 without what the backend said, and reports the error, when the backend fails", async () => {
    const stub = await startPrometheusStub();
    stub.fail({ status: 503, body: "upstream mimir-0.internal.example is down" });
    const errors: string[] = [];
    const { app, pod } = await appWithAlerts({
      metrics: backendFor(stub),
      metricsOptions: { onReadError: (instance, error) => errors.push(`${instance}: ${error}`) },
    });

    const { status, body } = await getJson(app, graphUrl(pod));

    expect(status).toBe(502);
    expect(body).toEqual({ error: "the metrics backend answered 503" });
    expect(errors).toEqual(["lab: PrometheusError: the metrics backend answered 503"]);
  });

  it("answers 502 when the backend answers something else than a matrix", async () => {
    const stub = await startPrometheusStub();
    stub.answer = () => ({ not: "a matrix" }) as never;
    const { app, pod } = await appWithAlerts({ metrics: backendFor(stub) });

    const { status, body } = await getJson(app, graphUrl(pod));

    expect(status).toBe(502);
    expect(body).toEqual({
      error: "the metrics backend answered something that is not a matrix",
    });
  });

  it("answers 502 when the backend takes too long", async () => {
    const stub = await startPrometheusStub();
    stub.hang();
    const { app, pod } = await appWithAlerts({
      metrics: backendFor(stub),
      metricsOptions: { queryTimeoutMs: 200 },
    });

    const { status, body } = await getJson(app, graphUrl(pod));

    expect(status).toBe(502);
    expect(body).toEqual({ error: "the metrics backend is unreachable (TimeoutError)" });
  });

  it("answers 502 without the URL when the backend is unreachable", async () => {
    const { app, pod } = await appWithAlerts({
      metrics: {
        lab: { url: `${await unreachableUrl()}/prometheus`, auth: null, headers: {}, matchers: {} },
      },
    });

    const { status, body } = await getJson(app, graphUrl(pod));

    expect(status).toBe(502);
    expect(body).toEqual({ error: "the metrics backend is unreachable (ECONNREFUSED)" });
  });
});
