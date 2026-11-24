import { describe, expect, it } from "vitest";
import {
  graphOf,
  type MetricSeries,
  maxNamedSeries,
  metricWindowOf,
  panelQueries,
  panelsFor,
  podOf,
  promqlString,
} from "../../src/domain/metrics.ts";

const podLabels = { alertname: "KubePodCrashLooping", namespace: "example-prod", pod: "api-0" };

describe("podOf", () => {
  it("is the pod an alert's namespace and pod labels name", () => {
    expect(podOf(podLabels)).toEqual({ namespace: "example-prod", pod: "api-0" });
  });

  it("is the pod a kube-state-metrics alert is about, with or without its container", () => {
    const fromKsm = { ...podLabels, job: "kube-state-metrics" };
    expect(podOf(fromKsm)).toEqual({ namespace: "example-prod", pod: "api-0" });
    expect(podOf({ ...fromKsm, container: "api" })).toEqual({
      namespace: "example-prod",
      pod: "api-0",
    });
  });

  it.each([
    ["a pod without a namespace", { pod: "api-0" }],
    ["a namespace alone", { namespace: "example-prod" }],
    ["a workload alone", { namespace: "example-prod", deployment: "api" }],
    ["an empty pod", { namespace: "example-prod", pod: "" }],
    [
      "kube-state-metrics' own pod, on its alert about a job",
      {
        namespace: "example-prod",
        pod: "kube-state-metrics-6d9f-x",
        container: "kube-state-metrics",
        job_name: "backup",
      },
    ],
    [
      "a node-exporter's pod, on its alert about a disk",
      { namespace: "monitoring", pod: "node-exporter-x", job: "node-exporter", device: "sda" },
    ],
  ])("is none for %s", (_, labels) => {
    expect(podOf(labels)).toBeNull();
  });
});

describe("panelsFor", () => {
  it("offers pod-cpu for an alert about a pod, nothing otherwise", () => {
    expect(panelsFor(podLabels)).toEqual(["pod-cpu"]);
    expect(panelsFor({ alertname: "TargetDown", namespace: "example-prod" })).toEqual([]);
  });
});

describe("metricWindowOf", () => {
  const now = new Date("2026-10-13T12:00:30Z");

  it("shows a firing alert's last 3 hours, a point a minute, aligned to the step", () => {
    const window = metricWindowOf(
      { status: "firing", endsAt: null, startsAt: new Date("2026-10-13T11:00:00Z") },
      now,
    );

    expect(window).toEqual({
      start: new Date("2026-10-13T09:00:00Z"),
      end: new Date("2026-10-13T12:00:00Z"),
      stepSeconds: 60,
    });
  });

  it("centres a resolved alert: 2½ hours before it, half an hour after it", () => {
    const window = metricWindowOf(
      {
        status: "resolved",
        startsAt: new Date("2026-10-12T08:00:00Z"),
        endsAt: new Date("2026-10-12T09:00:00Z"),
      },
      now,
    );

    expect(window).toEqual({
      start: new Date("2026-10-12T05:30:00Z"),
      end: new Date("2026-10-12T09:30:00Z"),
      stepSeconds: 60,
    });
  });

  it("ends a just resolved alert's window now, and keeps it 3 hours long", () => {
    const window = metricWindowOf(
      {
        status: "resolved",
        startsAt: new Date("2026-10-13T11:58:00Z"),
        endsAt: new Date("2026-10-13T11:59:00Z"),
      },
      now,
    );

    expect(window.end).toEqual(new Date("2026-10-13T12:00:00Z"));
    expect(window.start).toEqual(new Date("2026-10-13T09:00:00Z"));
  });

  it("shows the first day of a long alert, with fewer points", () => {
    const window = metricWindowOf(
      {
        status: "resolved",
        startsAt: new Date("2026-10-10T00:00:00Z"),
        endsAt: new Date("2026-10-12T00:00:00Z"),
      },
      now,
    );

    expect(window).toEqual({
      start: new Date("2026-10-09T21:30:00Z"),
      end: new Date("2026-10-10T21:30:00Z"),
      stepSeconds: 600,
    });
    const points = (window.end.getTime() - window.start.getTime()) / 1000 / window.stepSeconds;
    expect(points).toBeLessThanOrEqual(240);
  });
});

describe("panelQueries", () => {
  const window = { start: new Date(0), end: new Date(0), stepSeconds: 60 };

  it("asks for the pod's CPU per container, its requests and limits, with the configured matchers", () => {
    expect(panelQueries("pod-cpu", podLabels, { cluster: "lab" }, window)).toEqual([
      {
        role: "usage",
        promql:
          'sum by (container) (rate(container_cpu_usage_seconds_total{cluster="lab", namespace="example-prod", pod="api-0", container!="", image!=""}[180s]))',
        nameLabel: "container",
      },
      {
        role: "request",
        promql:
          'sum by (container) (kube_pod_container_resource_requests{cluster="lab", namespace="example-prod", pod="api-0", resource="cpu"})',
        nameLabel: "container",
      },
      {
        role: "limit",
        promql:
          'sum by (container) (kube_pod_container_resource_limits{cluster="lab", namespace="example-prod", pod="api-0", resource="cpu"})',
        nameLabel: "container",
      },
    ]);
  });

  it("widens the rate window with the step, so no sample falls between two points", () => {
    const [usage] = panelQueries("pod-cpu", podLabels, {}, { ...window, stepSeconds: 600 }) ?? [];
    expect(usage?.promql).toContain("[600s]");
  });

  it("keeps the alert's own namespace and pod over a configured matcher of that name", () => {
    const [usage] = panelQueries("pod-cpu", podLabels, { namespace: "other" }, window) ?? [];
    expect(usage?.promql).toContain('{namespace="example-prod", pod="api-0", container!=""');
  });

  it("puts a label value in the query only as a string literal", () => {
    const hostile = { namespace: "x", pod: 'a"} or vector(1) or up{a="\\\n' };
    const [usage] = panelQueries("pod-cpu", hostile, {}, window) ?? [];
    expect(usage?.promql).toContain('pod="a\\"} or vector(1) or up{a=\\"\\\\\\n"');
  });

  it("is none for an alert without a pod", () => {
    expect(panelQueries("pod-cpu", { namespace: "x" }, {}, window)).toBeNull();
  });
});

describe("promqlString", () => {
  it.each([
    ["plain", '"plain"'],
    ['a "quote"', '"a \\"quote\\""'],
    ["back\\slash", '"back\\\\slash"'],
    ["new\nline", '"new\\nline"'],
  ])("quotes %j", (value, literal) => {
    expect(promqlString(value)).toBe(literal);
  });
});

describe("graphOf", () => {
  const window = { start: new Date(0), end: new Date(120_000), stepSeconds: 60 };
  const series = (name: string, role: MetricSeries["role"], ...values: number[]) => ({
    name,
    role,
    points: values.map((value, index) => ({ at: new Date(index * 60_000), value })),
  });

  it("orders series by name, then usage, request and limit, and drops those without usage", () => {
    const graph = graphOf("pod-cpu", window, [
      series("sidecar", "usage", 0.01),
      series("api", "limit", 1),
      series("api", "usage", 0.5, 0.7),
      series("api", "request", 0.25),
      series("gone", "request", 0.1),
      series("idle", "usage"),
    ]);

    expect(graph.series.map((one) => `${one.name}/${one.role}`)).toEqual([
      "api/usage",
      "api/request",
      "api/limit",
      "sidecar/usage",
    ]);
    expect(graph).toMatchObject({ panel: "pod-cpu", unit: "cores", window, truncated: false });
  });

  it("keeps the busiest containers when there are too many", () => {
    const many = Array.from({ length: maxNamedSeries + 2 }, (_, index) =>
      series(`c${String(index).padStart(2, "0")}`, "usage", index),
    );

    const graph = graphOf("pod-cpu", window, many);

    expect(graph.truncated).toBe(true);
    expect(graph.series).toHaveLength(maxNamedSeries);
    expect(graph.series.map((one) => one.name)).not.toContain("c00");
  });
});
