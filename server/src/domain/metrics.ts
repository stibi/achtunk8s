import type { AlertState } from "./alert.ts";

// The graphs in an alert's details (ADR 0026): what an alert is about, the time window to
// show, and the queries for a Prometheus-compatible backend. The client names a panel and
// an occurrence; the queries are built here, from the alert's labels, never from the client.

/** A graph the client can ask for, by name. */
export type MetricPanelId = "pod-cpu";
export const metricPanelIds = ["pod-cpu"] as const satisfies readonly MetricPanelId[];

/** What a series in a panel is: what was used, or the request or limit to read it against. */
type SeriesRole = "usage" | "request" | "limit";

/** A pod an alert names with its `namespace` and `pod` labels. */
export interface Pod {
  readonly namespace: string;
  readonly pod: string;
}

/**
 * Exporters whose own pod and container are in the labels of alerts they report about
 * something else, as the scrape target's: a kube-state-metrics alert about a deployment or a
 * job, a node-exporter alert about a disk. kube-state-metrics' alerts about a pod carry that
 * pod and its container instead (its labels win over the target's), so they keep theirs.
 */
const reportingExporters: ReadonlySet<string> = new Set(["kube-state-metrics", "node-exporter"]);

/**
 * The alert's pod; null when its labels don't name one (e.g. only a deployment), or when
 * the pod they name is the exporter that reported it, or a node-exporter's: those alerts
 * are about something else.
 */
export function podOf(labels: Readonly<Record<string, string>>): Pod | null {
  const namespace = labels["namespace"];
  const pod = labels["pod"];
  const exporters = [labels["container"], labels["job"] === "node-exporter" ? "node-exporter" : ""];
  if (
    !namespace ||
    !pod ||
    exporters.some((name) => name !== undefined && reportingExporters.has(name))
  ) {
    return null;
  }
  return { namespace, pod };
}

/** A range query's span and resolution. */
export interface MetricWindow {
  readonly start: Date;
  readonly end: Date;
  readonly stepSeconds: number;
}

const minute = 60_000;
const hour = 60 * minute;
/** What a firing alert shows: the last 3 hours. */
const firingSpanMs = 3 * hour;
/** How far before a resolved alert's start its window begins. */
const leadMs = 150 * minute;
/** How far past a resolved alert's end its window goes, if the clock is there yet. */
const trailMs = 30 * minute;
/** The longest window: an alert that fired for days shows its first day. */
const maxSpanMs = 24 * hour;
/** At most this many points per series: a few hundred, whatever the span. */
const maxPoints = 240;
const steps = [60, 120, 300, 600, 900, 1800, 3600];

/**
 * The window a panel shows for an alert at `now`. Firing: the last 3 hours. Resolved: from
 * 2½ hours before it started to half an hour after it ended (or now, if sooner), at least 3
 * hours and at most a day. Both ends are aligned to the step, so a window and its cached
 * answer stay the same for a step's length.
 */
export function metricWindowOf(
  alert: AlertState & { readonly startsAt: Date },
  now: Date,
): MetricWindow {
  let start: number;
  let end: number;
  if (alert.status === "firing") {
    end = now.getTime();
    start = end - firingSpanMs;
  } else {
    end = Math.min(now.getTime(), alert.endsAt.getTime() + trailMs);
    start = Math.min(alert.startsAt.getTime() - leadMs, end - firingSpanMs);
    end = Math.min(end, start + maxSpanMs);
  }
  const stepSeconds = steps.find((step) => (end - start) / (step * 1000) <= maxPoints) ?? 3600;
  const stepMs = stepSeconds * 1000;
  return {
    start: new Date(Math.floor(start / stepMs) * stepMs),
    end: new Date(Math.floor(end / stepMs) * stepMs),
    stepSeconds,
  };
}

/** One query of a panel, and what its series are. */
export interface PanelQuery {
  readonly role: SeriesRole;
  readonly promql: string;
  /** The label that names each series, e.g. `container`. */
  readonly nameLabel: string;
}

/** A panel: which alerts it is for, its unit, and its queries for one of them. */
interface PanelDefinition {
  readonly unit: "cores";
  /** The queries for the alert, adding `matchers` to every selector; null when it doesn't apply. */
  queriesFor(
    labels: Readonly<Record<string, string>>,
    matchers: Readonly<Record<string, string>>,
    window: MetricWindow,
  ): readonly PanelQuery[] | null;
}

const panels: Readonly<Record<MetricPanelId, PanelDefinition>> = {
  "pod-cpu": {
    unit: "cores",
    queriesFor(labels, matchers, window) {
      const pod = podOf(labels);
      if (pod === null) {
        return null;
      }
      const selector = (extra: readonly string[]) =>
        matcherList({ ...matchers, namespace: pod.namespace, pod: pod.pod }, extra);
      // cAdvisor's series per container, as the kubernetes-mixin's recording rule takes them:
      // container "" is the pod's own cgroup, and no image the pause container. The rate
      // window covers at least one step, so no sample falls between two points, and 3
      // minutes, so a 1-minute scrape still has 3 samples.
      const usage = selector(['container!=""', 'image!=""']);
      const rateWindow = Math.max(180, window.stepSeconds);
      const resource = selector(['resource="cpu"']);
      return [
        {
          role: "usage",
          promql: `sum by (container) (rate(container_cpu_usage_seconds_total{${usage}}[${rateWindow}s]))`,
          nameLabel: "container",
        },
        // From kube-state-metrics; absent there, the graph has no reference lines.
        {
          role: "request",
          promql: `sum by (container) (kube_pod_container_resource_requests{${resource}})`,
          nameLabel: "container",
        },
        {
          role: "limit",
          promql: `sum by (container) (kube_pod_container_resource_limits{${resource}})`,
          nameLabel: "container",
        },
      ];
    },
  },
};

/** The panels that apply to an alert with these labels, in the order to show them. */
export function panelsFor(labels: Readonly<Record<string, string>>): MetricPanelId[] {
  const anyWindow = { start: new Date(0), end: new Date(0), stepSeconds: 60 };
  return metricPanelIds.filter((id) => panels[id].queriesFor(labels, {}, anyWindow) !== null);
}

/** The panel's queries for an alert with these labels; null when the panel doesn't apply. */
export function panelQueries(
  panel: MetricPanelId,
  labels: Readonly<Record<string, string>>,
  matchers: Readonly<Record<string, string>>,
  window: MetricWindow,
): readonly PanelQuery[] | null {
  return panels[panel].queriesFor(labels, matchers, window);
}

/**
 * Equality matchers for `labels`, then `extra` as written. A label of the alert overrides a
 * configured one of the same name.
 */
function matcherList(labels: Readonly<Record<string, string>>, extra: readonly string[]): string {
  return [
    ...Object.entries(labels).map(([name, value]) => `${name}=${promqlString(value)}`),
    ...extra,
  ].join(", ");
}

/**
 * A PromQL string literal holding exactly `value`. PromQL's double-quoted strings take Go's
 * escapes, a superset of JSON's, so the JSON encoding of a string is one.
 */
export function promqlString(value: string): string {
  return JSON.stringify(value);
}

/** One sample of a series. */
export interface MetricPoint {
  readonly at: Date;
  readonly value: number;
}

export interface MetricSeries {
  /** E.g. the container's name. */
  readonly name: string;
  readonly role: SeriesRole;
  /** Oldest first, only where the backend has a value: a gap is missing points. */
  readonly points: readonly MetricPoint[];
}

/** A panel's answer: its series for the window. */
export interface MetricGraph {
  readonly panel: MetricPanelId;
  readonly unit: PanelDefinition["unit"];
  readonly window: MetricWindow;
  readonly series: readonly MetricSeries[];
  /** True when series were left out over `maxNamedSeries`. */
  readonly truncated: boolean;
}

/** The most series of one role a graph shows: a pod with more containers is rare. */
export const maxNamedSeries = 10;

/**
 * The graph from every query's series: the `maxNamedSeries` busiest names by their highest
 * usage, each with its usage, request and limit, by name. Requests and limits of names
 * without usage are left out: there is nothing to read them against.
 */
export function graphOf(
  panel: MetricPanelId,
  window: MetricWindow,
  series: readonly MetricSeries[],
): MetricGraph {
  const peak = (points: readonly MetricPoint[]) =>
    points.reduce((highest, point) => Math.max(highest, point.value), Number.NEGATIVE_INFINITY);
  const usage = series
    .filter((one) => one.role === "usage" && one.points.length > 0)
    .sort((a, b) => peak(b.points) - peak(a.points) || a.name.localeCompare(b.name));
  const shown = new Set(usage.slice(0, maxNamedSeries).map((one) => one.name));
  const roles: readonly SeriesRole[] = ["usage", "request", "limit"];
  return {
    panel,
    unit: panels[panel].unit,
    window,
    series: series
      .filter((one) => shown.has(one.name) && one.points.length > 0)
      .sort(
        (a, b) => a.name.localeCompare(b.name) || roles.indexOf(a.role) - roles.indexOf(b.role),
      ),
    truncated: usage.length > shown.size,
  };
}
