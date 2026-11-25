import { describe, expect, it } from "vitest";
import { agentReport } from "../src/agent-report.ts";
import type { Occurrence } from "../src/protocol.ts";

// The same alert and the same expected text as the macOS client's AgentReportTests:
// the two reports are one format.

const occurrence: Occurrence = {
  id: 42,
  instance: "eu-prod",
  channel: "payments",
  source: "alertmanager",
  sourceKey: "3f9c2e1a",
  status: "firing",
  severity: "critical",
  title: "CardAuthorisationsFailing",
  summary: "7% of card authorisations failed.",
  labels: {
    alertname: "CardAuthorisationsFailing",
    severity: "critical",
    cluster: "eu-prod-1",
    namespace: "payments",
    pod: "payments-api-7f9c4d-x2kq",
    job: "payments-api",
    team: "payments",
    prometheus: "monitoring/k8s",
    endpoint: "http",
    container: "api",
    instance: "10.0.3.17:8080",
    service: "payments-api",
  },
  annotations: {
    summary: "7% of card authorisations failed.",
    description: "Failures started after the 07:30 deploy.\nCheck the PSP status page.",
    runbook_url: "https://runbooks.example.com/card-auth",
    dashboard_url: "https://grafana.example.com/d/payments",
    owner: "team-payments",
  },
  links: [{ kind: "runbook", url: "https://runbooks.example.com/card-auth" }],
  startsAt: "2026-10-26T07:33:20.000Z",
  endsAt: null,
  firstReceivedAt: "2026-10-26T07:33:20.000Z",
  lastReceivedAt: "2026-10-26T08:33:20.000Z",
  lastEventAt: "2026-10-26T08:33:20.000Z",
  lastEventKind: "resent",
  notificationCount: 13,
  silencedUntil: null,
};

const events = [
  { id: 1, kind: "fired", cause: null, recordedAt: "2026-10-26T07:33:20.000Z" },
  { id: 2, kind: "resent", cause: null, recordedAt: "2026-10-26T08:33:20.000Z" },
];

const expected = `# CardAuthorisationsFailing

- State: firing, resent
- Severity: critical
- Source: alertmanager, instance \`eu-prod\`, channel \`#payments\`
- Started: 2026-10-26T07:33:20Z
- Last event: resent at 2026-10-26T08:33:20Z
- Received: first 2026-10-26T07:33:20Z, last 2026-10-26T08:33:20Z, 13 notifications
- Source key (fingerprint): \`3f9c2e1a\`
- Achtung occurrence: 42

## Summary

7% of card authorisations failed.

## Description

Failures started after the 07:30 deploy.
Check the PSP status page.

## Links

- Runbook: https://runbooks.example.com/card-auth
- Dashboard (\`dashboard_url\`): https://grafana.example.com/d/payments

## Annotations

- \`dashboard_url\`: https://grafana.example.com/d/payments
- \`owner\`: team-payments
- \`runbook_url\`: https://runbooks.example.com/card-auth

## Labels

\`\`\`
alertname=CardAuthorisationsFailing
cluster=eu-prod-1
container=api
endpoint=http
instance=10.0.3.17:8080
job=payments-api
namespace=payments
pod=payments-api-7f9c4d-x2kq
prometheus=monitoring/k8s
service=payments-api
severity=critical
team=payments
\`\`\`

## History

- 2026-10-26T07:33:20Z fired
- 2026-10-26T08:33:20Z resent
`;

const now = new Date("2026-10-26T09:33:20Z");

describe("agentReport", () => {
  it("has the facts, the prose, the links, the annotations, the labels and the history", () => {
    expect(agentReport({ occurrence, events }, now)).toBe(expected);
  });

  it("leaves out the empty sections of a bare alert", () => {
    const report = agentReport(
      {
        occurrence: {
          ...occurrence,
          status: "resolved",
          endsAt: "2026-10-26T07:43:20.000Z",
          summary: null,
          labels: {},
          annotations: {},
          links: [],
          lastEventKind: "resolved",
          notificationCount: 1,
        },
      },
      now,
    );

    expect(report).toContain("- State: resolved\n");
    expect(report).toContain("- Resolved: 2026-10-26T07:43:20Z\n");
    expect(report).toContain(", 1 notification\n");
    expect(report).not.toContain("## ");
  });

  it("keeps a multiline annotation inside its list item", () => {
    const report = agentReport(
      { occurrence: { ...occurrence, annotations: { query: "sum(rate(x[5m]))\n  > 0.05" } } },
      now,
    );

    expect(report).toContain("- `query`: sum(rate(x[5m]))\n    > 0.05\n");
  });

  it("shows a silence only while it lasts", () => {
    const silenced = { ...occurrence, silencedUntil: "2026-10-26T10:00:00.000Z" };

    expect(agentReport({ occurrence: silenced }, now)).toContain(
      "- State: firing, resent, silenced until 2026-10-26T10:00:00Z\n",
    );
    expect(agentReport({ occurrence: silenced }, new Date("2026-10-26T10:00:00Z"))).toContain(
      "- State: firing, resent\n",
    );
  });

  it("fences the labels with more backticks than any label has", () => {
    const report = agentReport({ occurrence: { ...occurrence, labels: { note: "a ``` b" } } }, now);

    expect(report).toContain("````\nnote=a ``` b\n````");
  });

  it("says what a vanished resolve and a reminder were", () => {
    const report = agentReport(
      {
        occurrence,
        events: [
          { id: 1, kind: "resolved", cause: "vanished", recordedAt: "2026-10-26T07:40:00Z" },
          {
            id: 2,
            kind: "reminder_set",
            cause: null,
            recordedAt: "2026-10-26T07:41:00Z",
            remindAt: "2026-10-26T09:00:00Z",
          },
        ],
      },
      now,
    );

    expect(report).toContain(
      "- 2026-10-26T07:40:00Z resolved (gone from Alertmanager: Achtung resolved it itself, Alertmanager never sent the resolve)\n",
    );
    expect(report).toContain("- 2026-10-26T07:41:00Z reminder_set for 2026-10-26T09:00:00Z\n");
  });

  it("titles a link annotation by its name, and skips one that isn't a lone URL", () => {
    const annotations = {
      grafanaDashboardURL: "https://grafana.example.com/d/1",
      "logs-link": "https://logs.example.com/q",
      note: "see https://wiki.example.com first",
      ftp: "ftp://files.example.com/x",
    };

    const report = agentReport({ occurrence: { ...occurrence, annotations, links: [] } }, now);

    expect(report).toContain(
      "- Grafana dashboard (`grafanaDashboardURL`): https://grafana.example.com/d/1\n",
    );
    expect(report).toContain("- Logs (`logs-link`): https://logs.example.com/q\n");
    expect(report).not.toContain("(`note`)");
    expect(report).not.toContain("(`ftp`)");
  });
});
