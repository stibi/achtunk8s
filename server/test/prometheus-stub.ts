import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

interface StubRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** A series as Prometheus answers it in a matrix: labels and [unix seconds, "value"] pairs. */
interface StubSeries {
  readonly metric: Record<string, string>;
  readonly values: [number, string][];
}

/**
 * A stand-in for a Prometheus-compatible query API under /prometheus (Mimir's prefix), so
 * tests never reach a real one. It answers a range query with what `answer` returns for its
 * PromQL, as a matrix.
 */
export interface PrometheusStub {
  /** The base URL, with the /prometheus prefix. */
  readonly url: string;
  readonly requests: StubRequest[];
  /** The series to answer a query with; none by default. */
  answer: (promql: string) => StubSeries[];
  /** Answer every request with this status and body instead; null answers again. */
  fail(failure: { status: number; body: string } | null): void;
  /** Never answer, until the test ends. */
  hang(): void;
}

export async function startPrometheusStub(): Promise<PrometheusStub> {
  const requests: StubRequest[] = [];
  let failure: { status: number; body: string } | null = null;
  let hanging = false;
  const stub: PrometheusStub = {
    url: "",
    requests,
    answer: () => [],
    fail: (next) => {
      failure = next;
    },
    hang: () => {
      hanging = true;
    },
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://prometheus");
    // The system may hand this port out again after another test file's stub closed, and an
    // app there may still poll it: only requests under our prefix are this test's.
    if (!url.pathname.startsWith("/prometheus/")) {
      response.writeHead(404).end("not found");
      return;
    }
    requests.push({ path: url.pathname, query: url.searchParams, headers: request.headers });
    if (hanging) {
      return;
    }
    if (failure !== null) {
      response.writeHead(failure.status, { "content-type": "text/plain" }).end(failure.body);
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/prometheus/api/v1/query_range") {
      response.writeHead(404).end("not found");
      return;
    }
    const result = stub.answer(url.searchParams.get("query") ?? "");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ status: "success", data: { resultType: "matrix", result } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return Object.assign(stub, { url: `http://127.0.0.1:${port}/prometheus` });
}
