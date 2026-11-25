import { describe, expect, it } from "vitest";
import {
  appliesTo,
  handlerLost,
  isConnected,
  isSameResult,
  overdue,
} from "../../src/domain/handover.ts";

const at = (time: string) => new Date(`2026-11-15T${time}Z`);
const alert = {
  instance: "lab",
  severity: "critical",
  labels: { alertname: "TargetDown", namespace: "example-prod" },
} as const;
const everything = { instances: [], severities: [], labels: {} };

describe("appliesTo", () => {
  it("matches every alert when nothing is given", () => {
    expect(appliesTo(everything, alert)).toBe(true);
  });

  it.each([
    ["its instance among the instances", { instances: ["edge", "lab"] }, true],
    ["another instance", { instances: ["edge"] }, false],
    ["its severity among the severities", { severities: ["warning", "critical"] }, true],
    ["another severity", { severities: ["warning"] }, false],
    ["a label with exactly that value", { labels: { namespace: "example-prod" } }, true],
    ["a label with another value", { labels: { namespace: "example" } }, false],
    ["a label the alert lacks", { labels: { pod: "api" } }, false],
    [
      "one part that matches and one that doesn't",
      { instances: ["lab"], labels: { alertname: "Other" } },
      false,
    ],
    [
      "every part matching",
      { instances: ["lab"], severities: ["critical"], labels: { alertname: "TargetDown" } },
      true,
    ],
  ] as const)("with %s is %s", (_, scope, expected) => {
    expect(appliesTo({ ...everything, ...scope }, alert)).toBe(expected);
  });
});

describe("isConnected", () => {
  const handler = { id: "herdr-agent", lastSeenAt: at("10:00:00") };

  it("holds for 90 seconds after the handler's last call", () => {
    expect(isConnected(handler, [], at("10:01:29"))).toBe(true);
    expect(isConnected(handler, [], at("10:01:30"))).toBe(false);
  });

  it("holds while the handler has a running handover, whenever it last called", () => {
    const later = at("10:01:50");

    expect(isConnected(handler, [{ handler: "herdr-agent", state: "running" }], later)).toBe(true);
    expect(isConnected(handler, [{ handler: "herdr-agent", state: "requested" }], later)).toBe(
      false,
    );
    expect(isConnected(handler, [{ handler: "llm", state: "running" }], later)).toBe(false);
  });
});

describe("overdue", () => {
  it("expires a handover nobody claimed for 10 minutes, at that moment", () => {
    const requested = { state: "requested", requestedAt: at("10:00:00") } as const;

    expect(overdue(requested, at("10:09:59"))).toBeNull();
    expect(overdue(requested, at("10:25:00"))).toEqual({
      state: "expired",
      finishedAt: at("10:10:00"),
    });
  });

  const running = {
    state: "running",
    leaseExpiresAt: at("10:02:00"),
    deadlineAt: at("10:10:00"),
  } as const;

  it("leaves a running handover alone within its lease and deadline", () => {
    expect(overdue(running, at("10:01:59"))).toBeNull();
  });

  it("fails one whose lease ran out, when it ran out", () => {
    expect(overdue(running, at("10:30:00"))).toEqual({
      state: "failed",
      finishedAt: at("10:02:00"),
      error: handlerLost,
    });
  });

  it("times out one past its deadline while its lease still holds", () => {
    const renewed = { ...running, leaseExpiresAt: at("10:11:00") };

    expect(overdue(renewed, at("10:09:59"))).toBeNull();
    expect(overdue(renewed, at("10:10:00"))).toEqual({
      state: "timed_out",
      finishedAt: at("10:10:00"),
    });
  });
});

describe("isSameResult", () => {
  const succeeded = {
    state: "succeeded",
    claimedAt: at("10:00:00"),
    finishedAt: at("10:05:00"),
    summary: "Out of memory",
    body: "Details",
    links: [{ title: "Dashboard", url: "https://grafana.example.com/d/1" }],
  } as const;
  const result = {
    outcome: "succeeded",
    summary: "Out of memory",
    body: "Details",
    links: [{ title: "Dashboard", url: "https://grafana.example.com/d/1" }],
  } as const;

  it("knows a result sent again", () => {
    expect(isSameResult(succeeded, result)).toBe(true);
  });

  it.each([
    ["another summary", { ...result, summary: "Disk full" }],
    ["another body", { ...result, body: "Other details" }],
    ["other links", { ...result, links: [] }],
    ["a failure", { outcome: "failed", error: "Out of memory" }],
  ] as const)("tells %s apart", (_, other) => {
    expect(isSameResult(succeeded, other)).toBe(false);
  });

  it("compares a failure by its error", () => {
    const failed = { ...succeeded, state: "failed", error: "No access" } as const;

    expect(isSameResult(failed, { outcome: "failed", error: "No access" })).toBe(true);
    expect(isSameResult(failed, { outcome: "failed", error: "Timeout" })).toBe(false);
    expect(isSameResult({ state: "requested" }, { outcome: "failed", error: "No access" })).toBe(
      false,
    );
  });
});
