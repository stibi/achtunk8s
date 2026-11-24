import { type PrometheusEndpoint, PrometheusError, queryRange } from "../clients/prometheus.ts";
import type { Database } from "../db/client.ts";
import { findOccurrence } from "../db/queries.ts";
import {
  graphOf,
  type MetricGraph,
  type MetricPanelId,
  type MetricSeries,
  metricWindowOf,
  panelQueries,
  panelsFor,
} from "../domain/metrics.ts";
import type { Occurrence } from "../domain/occurrence.ts";
import { type CachedRead, cachedRead } from "./alertmanager-reads.ts";

/** An instance's metrics backend, and the matchers added to every query there. */
export type MetricsBackend = PrometheusEndpoint & {
  readonly matchers: Readonly<Record<string, string>>;
};

/** The graphs in an alert's details, from its instance's metrics backend (ADR 0026). */
export interface Metrics {
  /** The panels the occurrence has: none when its instance has no backend. */
  panelsOf(occurrence: Occurrence): MetricPanelId[];
  /** The panel's graph for the occurrence now; null when it doesn't have that panel. */
  graphOf(occurrence: Occurrence, panel: MetricPanelId): Promise<MetricGraphResult | null>;
}

type MetricGraphResult =
  | { readonly kind: "read"; readonly graph: MetricGraph }
  | { readonly kind: "failed"; readonly reason: string };

export interface MetricsOptions {
  readonly now?: () => Date;
  /** How long a query may take; 10 seconds by default. */
  readonly queryTimeoutMs?: number;
  /** A query failed; the client shows the reason. */
  readonly onReadError?: (instance: string, error: PrometheusError) => void;
}

// The same graph is asked again by every open client every minute, and the window moves by
// a step: answers are reused for 30 seconds, so the backend sees about one query per graph
// a step. The cache holds at most this many graphs, the oldest dropped first.
const metricsReads = { freshForMs: 30_000, failure: PrometheusError };
const cachedGraphs = 200;

export function metricsFrom(
  backends: ReadonlyMap<string, MetricsBackend>,
  { now = () => new Date(), onReadError = () => {}, queryTimeoutMs }: MetricsOptions = {},
): Metrics {
  const cache = new Map<string, CachedRead<MetricGraph, PrometheusError>>();
  const cachedFor = (key: string, read: () => Promise<MetricGraph>, instance: string) => {
    let entry = cache.get(key);
    if (entry === undefined) {
      entry = cachedRead(read, now, (error) => onReadError(instance, error), metricsReads);
      cache.set(key, entry);
      for (const oldest of cache.keys()) {
        if (cache.size <= cachedGraphs) {
          break;
        }
        cache.delete(oldest);
      }
    }
    return entry;
  };

  return {
    panelsOf: (occurrence) =>
      backends.has(occurrence.instance) ? panelsFor(occurrence.labels) : [],
    async graphOf(occurrence, panel) {
      const backend = backends.get(occurrence.instance);
      const window = metricWindowOf(occurrence, now());
      const queries =
        backend === undefined
          ? null
          : panelQueries(panel, occurrence.labels, backend.matchers, window);
      if (backend === undefined || queries === null) {
        return null;
      }
      const key = JSON.stringify([occurrence.instance, panel, queries, window]);
      const read = async () => {
        const answers = await Promise.all(
          queries.map(async (query) =>
            (await queryRange(backend, query.promql, window, queryTimeoutMs)).map(
              (series): MetricSeries => ({
                name: series.labels[query.nameLabel] ?? "",
                role: query.role,
                points: series.points,
              }),
            ),
          ),
        );
        return graphOf(panel, window, answers.flat());
      };
      // The same window's last answer, if one was read, is still right when a read fails.
      const reading = await cachedFor(key, read, occurrence.instance).read();
      if (reading.last === null) {
        return { kind: "failed", reason: reading.error?.message ?? "no graph read yet" };
      }
      return { kind: "read", graph: reading.last.value };
    },
  };
}

export type OccurrenceGraphResult =
  | MetricGraphResult
  | { readonly kind: "not-found" }
  | { readonly kind: "no-panel" };

/** The panel's graph for occurrence `id`. */
export async function getOccurrenceGraph(
  db: Database,
  metrics: Metrics,
  id: number,
  panel: MetricPanelId,
): Promise<OccurrenceGraphResult> {
  const occurrence = await findOccurrence(db, id);
  if (occurrence === null) {
    return { kind: "not-found" };
  }
  return (await metrics.graphOf(occurrence, panel)) ?? { kind: "no-panel" };
}
