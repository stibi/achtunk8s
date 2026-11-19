import { z } from "zod";
import { type MetricGraph, metricPanelIds } from "../domain/metrics.ts";
import type { Api, Inbox } from "./api-contract.ts";
import { errorBody, timestamp } from "./api-schemas.ts";

const metricGraphBody = z
  .object({
    panel: z.string().describe("The panel asked for, e.g. pod-cpu"),
    unit: z.enum(["cores"]).describe("What the values are: CPU cores for pod-cpu"),
    from: timestamp.describe("The window's start"),
    to: timestamp.describe("The window's end"),
    stepSeconds: z.int().positive().describe("The time between two points"),
    series: z
      .array(
        z.object({
          name: z.string().describe("What the series is of, e.g. the container's name"),
          role: z
            .enum(["usage", "request", "limit"])
            .describe(
              "usage: what was used; request and limit: the Kubernetes request and limit to read it against",
            ),
          points: z
            .array(z.object({ at: timestamp, value: z.number() }))
            .describe(
              "Oldest first, one per step where the backend has a value: a gap is missing points, " +
                "and a series that ends early ended (e.g. the pod is gone)",
            ),
        }),
      )
      .describe("By name, then usage, request, limit. Without usage there are no series"),
    truncated: z
      .boolean()
      .describe("True when series were left out: only the 10 with the highest usage are sent"),
  })
  .meta({ id: "MetricGraph" });

export function registerMetricsRoutes(api: Api, inbox: Inbox): void {
  api.get(
    "/api/occurrences/:id/metrics/:panel",
    {
      schema: {
        tags: ["client"],
        operationId: "getOccurrenceMetrics",
        summary: "A graph of what the occurrence's alert is about, from its metrics backend",
        description:
          "The server builds the query from the alert's labels and the panel: pod-cpu is the CPU " +
          "usage of each container of the alert's pod (its namespace and pod labels), with their " +
          "requests and limits. The window: for a firing alert the last 3 hours; for a resolved " +
          "one from 2.5 hours before it started to 30 minutes after it ended or now, at least 3 " +
          "hours and at most a day. Answers are reused for 30 seconds (ADR 0026). " +
          "404: no such occurrence, or it has no such panel (see metricPanels in its detail). " +
          "502: the metrics backend was unreachable or refused the query.",
        params: z.object({
          id: z.coerce.number().int().positive(),
          panel: z.enum(metricPanelIds),
        }),
        response: { 200: metricGraphBody, 400: errorBody, 404: errorBody, 502: errorBody },
      },
    },
    async (request, reply) => {
      const result = await inbox.getOccurrenceGraph(request.params.id, request.params.panel);
      switch (result.kind) {
        case "read":
          return toMetricGraphBody(result.graph);
        case "not-found":
          return reply.code(404).send({ error: "Occurrence not found" });
        case "no-panel":
          return reply.code(404).send({ error: "The occurrence has no such graph" });
        case "failed":
          return reply.code(502).send({ error: result.reason });
      }
    },
  );
}

function toMetricGraphBody(graph: MetricGraph): z.infer<typeof metricGraphBody> {
  return {
    panel: graph.panel,
    unit: graph.unit,
    from: graph.window.start.toISOString(),
    to: graph.window.end.toISOString(),
    stepSeconds: graph.window.stepSeconds,
    series: graph.series.map((series) => ({
      name: series.name,
      role: series.role,
      points: series.points.map((point) => ({ at: point.at.toISOString(), value: point.value })),
    })),
    truncated: graph.truncated,
  };
}
