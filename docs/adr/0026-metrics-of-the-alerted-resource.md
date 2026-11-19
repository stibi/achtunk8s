# 0026: Metrics of the alerted resource, from the server

- Status: proposed
- Date: 2026-11-19

## Context

The user wants an alert's details to show telemetry of what the alert is about: for an
OOM-killed pod, its memory over the last hours. The first version is one graph, a pod's
CPU over 3 hours, designed so memory, other resources (node, deployment, PVC) and a
selectable time span can follow.

The metrics live in Prometheus or a Prometheus-compatible store (Mimir, Thanos,
VictoriaMetrics), usually one per cluster, i.e. per instance (ADR 0006), or one central
store holding many clusters. They are on private networks and may need credentials. The
macOS app only knows the Achtung server. There are no users (ADR 0002): whoever reaches
the API reaches whatever the server queries for it.

## Decision

- **The server queries the metrics backend; the app asks the server.** As with silences
  (ADR 0008), the backend's address and credentials stay with the server.
- **The client names a panel, never a query.** `GET /api/occurrences/{id}/metrics/{panel}`,
  with `panel` one of a fixed set (`pod-cpu` for now). The server builds the PromQL from the
  alert's labels and the panel; label values go in as escaped string literals in equality
  matchers. The API can't run arbitrary PromQL, so it isn't a proxy into the metrics.
- **The occurrence's detail lists its panels** (`metricPanels`), so the app shows a graph
  only where there is one, without asking: none when the instance has no backend or the
  labels name nothing a panel draws. It is a list of strings, not an enum, so an older app
  skips panels it doesn't know.
- **What is "about a pod":** the `namespace` and `pod` labels, which the kubernetes-mixin
  (kube-prometheus-stack) alerts about pods and containers carry (KubePodCrashLooping,
  KubePodNotReady, KubeContainerWaiting, CPUThrottlingHigh, OOM-kill alerts on
  `kube_pod_container_status_last_terminated_reason`). Alerts with only a workload label
  (`deployment`, `statefulset`, `job_name`) or only a `container` get no graph for now.
  prometheus-operator adds the scrape target's `namespace`, `pod` and `container` to every
  series, so alerts about something else carry the exporter's pod: kube-state-metrics'
  alerts about a deployment or a job (`container="kube-state-metrics"`) and node-exporter's
  about a node (`job="node-exporter"`) get no graph. (Its alerts about a pod carry that pod
  and its container, which win over the target's.) Seen in real alerts.
- **`pod-cpu`:** `sum by (container) (rate(container_cpu_usage_seconds_total{namespace,pod,
  container!="",image!=""}[w]))` from cAdvisor (the kubernetes-mixin's own filter), `w` the larger of 3 minutes and the
  step; and `sum by (container)` of `kube_pod_container_resource_requests` and `_limits`
  with `resource="cpu"` from kube-state-metrics. Without kube-state-metrics the graph has
  no reference lines and still works.
- **The window:** a firing alert shows the last 3 hours. A resolved one shows from 2½ hours
  before it started to 30 minutes after it ended (or now), at least 3 hours and at most a
  day (its first day). The step is a minute, wider for longer windows, so a series has at
  most 240 points; both ends are aligned to the step. The app marks the alert's start and
  end on the time axis.
- **Configuration:** `METRICS`, JSON of instance name → `{ url, username?, password?,
  bearerToken?, headers?, matchers? }`, set from a secret. `url` is the base the API hangs
  off (`<url>/api/v1/query_range`); basic auth or a bearer token, not both; `headers` for
  e.g. Mimir's `X-Scope-OrgID` (not `Authorization`); `matchers` adds equality matchers to
  every query, e.g. `{"cluster": "prod"}` for a store with many clusters. Credentials in
  the URL are rejected, like `ALERTMANAGERS`.
- **A polite client:** 10-second timeout, at most 200 series per answer, the 10 busiest
  containers sent; an answer is reused for 30 seconds per (instance, panel, query, window),
  so many open apps cost one query a step; at most 200 graphs are cached. Errors name a
  status or a code, never the URL or what the backend answered: 502 to the app.
- **The app refreshes a firing alert's graph every minute** while its details are open and
  the app is active; the change stream carries no metrics.

## Consequences

- **A new dependency and a new endpoint.** The server needs network access to each
  backend, and holds its credentials. Anyone who can reach Achtung can read the CPU of the
  pods its alerts name, nothing else.
- **Escaping matters.** Alert labels come from webhooks; the tests send a pod name that
  tries to close the matcher and add a selector.
- **Other exporters' alerts can graph the exporter.** An alert from another exporter scraped
  through a ServiceMonitor (a Redis or Postgres exporter, say) names the exporter's pod, which
  is often the pod in trouble, but not always. Only kube-state-metrics and node-exporter are
  known not to be.
- **A metric scraped twice adds up.** If the kubelet's `/metrics/resource` is scraped next
  to `/metrics/cadvisor`, both have `container_cpu_usage_seconds_total`; `matchers` can pin
  e.g. `{"metrics_path": "/metrics/cadvisor"}`.
- **The card appears when the occurrence's detail arrives**, which says whether it has a
  graph; that moves the annotations and labels below it down once, right after an alert is
  selected. The plot itself keeps its height from loading to drawn.
- **Pod names are not unique across clusters.** A central store needs `matchers` per
  instance; without it, two clusters' pods of the same name and namespace add up.
- **Request and limit lines are per container,** drawn for the alert's own container (its
  `container` label) or the only one; for a pod with several containers and an alert that
  names none, the legend lists the containers and no reference line is drawn.
- **Adding a panel** is an entry in `src/domain/metrics.ts`'s registry (which labels it
  needs, its unit, its queries), a value in the route's enum, and in the app a
  `MetricPanel` case and its view. `pod-memory` reuses `podOf` with
  `container_memory_working_set_bytes` and the memory requests and limits. A node or a
  deployment needs its own target from the labels (`node`, or `deployment` joined through
  `kube_pod_owner` and `kube_replicaset_owner`). A time span to choose is a query parameter
  from a fixed set, passed to `metricWindowOf`.
