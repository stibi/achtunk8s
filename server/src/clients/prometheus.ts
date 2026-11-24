import { z } from "zod";
import type { MetricPoint, MetricWindow } from "../domain/metrics.ts";
import { reasonOf } from "./failure-reason.ts";

// The Prometheus HTTP API's range queries, which Mimir, Thanos and VictoriaMetrics speak too:
// https://prometheus.io/docs/prometheus/latest/querying/api/#range-queries

/** Where an instance's metrics are, and how to authenticate there. */
export interface PrometheusEndpoint {
  /** The base the API hangs off, e.g. https://mimir.example.com/prometheus. */
  readonly url: string;
  readonly auth:
    | { readonly kind: "basic"; readonly username: string; readonly password: string }
    | { readonly kind: "bearer"; readonly token: string }
    | null;
  /** Sent with every query, e.g. Mimir's X-Scope-OrgID. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The backend could not be reached, refused the query, or answered something else than a
 * matrix. The message names neither the URL nor credentials nor what the backend answered,
 * so it is safe to log and to show.
 */
export class PrometheusError extends Error {
  override readonly name = "PrometheusError";
}

const defaultTimeoutMs = 10_000;
/** More series than a graph could show is a query gone wrong; refuse it. */
const maxSeries = 200;

const matrixBody = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        // [unix seconds, "value"]; the value can be "NaN" or "+Inf".
        values: z.array(z.tuple([z.number(), z.string()])),
      }),
    ),
  }),
});

/** One series of a range query's answer. */
export interface RangeSeries {
  readonly labels: Readonly<Record<string, string>>;
  /** Oldest first, without the samples that aren't finite numbers. */
  readonly points: readonly MetricPoint[];
}

/** Runs `promql` over `window` at its step, giving up after `timeoutMs`. */
export async function queryRange(
  endpoint: PrometheusEndpoint,
  promql: string,
  window: MetricWindow,
  timeoutMs = defaultTimeoutMs,
): Promise<RangeSeries[]> {
  const base = endpoint.url.endsWith("/") ? endpoint.url : `${endpoint.url}/`;
  const url = new URL("api/v1/query_range", base);
  url.search = new URLSearchParams({
    query: promql,
    start: String(window.start.getTime() / 1000),
    end: String(window.end.getTime() / 1000),
    step: String(window.stepSeconds),
    // Prometheus' own timeout for the query, a little under ours.
    timeout: `${Math.max(1, Math.floor(timeoutMs / 1000) - 1)}s`,
  }).toString();
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      headers: { ...endpoint.headers, accept: "application/json", ...authorization(endpoint) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw new PrometheusError(`the metrics backend is unreachable (${reasonOf(error)})`);
  }
  if (!response.ok) {
    throw new PrometheusError(`the metrics backend answered ${response.status}`);
  }
  const parsed = matrixBody.safeParse(jsonOf(text));
  if (!parsed.success) {
    throw new PrometheusError("the metrics backend answered something that is not a matrix");
  }
  const { result } = parsed.data.data;
  if (result.length > maxSeries) {
    throw new PrometheusError(`the metrics backend answered ${result.length} series`);
  }
  return result.map(({ metric, values }) => ({
    labels: metric,
    points: values.flatMap(([seconds, value]) => {
      const number = Number(value);
      return Number.isFinite(number) ? [{ at: new Date(seconds * 1000), value: number }] : [];
    }),
  }));
}

function authorization({ auth }: PrometheusEndpoint): { authorization?: string } {
  switch (auth?.kind) {
    case "basic":
      return {
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
      };
    case "bearer":
      return { authorization: `Bearer ${auth.token}` };
    case undefined:
      return {};
  }
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PrometheusError("the metrics backend answered with something that is not JSON");
  }
}
