import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { crashLoop, crashLoopResolved, deliver, getJson, targetDown, titles } from "../api.ts";
import { appWithDatabase } from "../app.ts";

// Reminders resurface an occurrence at a time the user picked (ADR 0025).

async function labWithCrashLoop() {
  let current = new Date("2026-10-13T09:00:00Z");
  const { app, services, remindDue } = await appWithDatabase({ now: () => current });
  await deliver(services, [crashLoop], "2026-10-13T08:30:00Z");
  await deliver(services, [targetDown], "2026-10-13T08:45:00Z");
  const { body } = await getJson(app, "/api/occurrences");
  const id: number = body.occurrences.find(
    (occurrence: { title: string }) => occurrence.title === crashLoop.title,
  ).id;
  return {
    app,
    services,
    id,
    /** Moves the services' clock, then runs the sweep main.ts runs. */
    remindAt: (time: string) => {
      current = new Date(time);
      return remindDue();
    },
    at: (time: string) => {
      current = new Date(time);
    },
    detail: async () => (await getJson(app, `/api/occurrences/${id}`)).body,
  };
}

const setReminder = (app: FastifyInstance, id: number, remindAt: unknown) =>
  app.inject({ method: "PUT", url: `/api/occurrences/${id}/reminder`, body: { remindAt } });

const cancelReminder = (app: FastifyInstance, id: number) =>
  app.inject({ method: "DELETE", url: `/api/occurrences/${id}/reminder` });

const history = (detail: {
  events: { kind: string; recordedAt: string; remindAt: string | null }[];
}) => detail.events.map(({ kind, recordedAt, remindAt }) => [kind, recordedAt, remindAt]);

describe("PUT /api/occurrences/{id}/reminder", () => {
  it("sets a reminder, in the history and on the occurrence, without making it news", async () => {
    const { app, id, detail } = await labWithCrashLoop();

    const response = await setReminder(app, id, "2026-10-14T06:00:00Z");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      remindAt: "2026-10-14T06:00:00.000Z",
      lastEventAt: "2026-10-13T08:30:00.000Z",
      lastEventKind: "fired",
    });
    expect(history(await detail())).toEqual([
      ["fired", "2026-10-13T08:30:00.000Z", null],
      ["reminder_set", "2026-10-13T09:00:00.000Z", "2026-10-14T06:00:00.000Z"],
    ]);
    // It doesn't move up the list: setting a reminder is not a change to show anyone.
    expect(await titles(app, "/api/occurrences")).toEqual([targetDown.title, crashLoop.title]);
    expect((await detail()).occurrence.remindAt).toBe("2026-10-14T06:00:00.000Z");
  });

  it("replaces the reminder the occurrence has; only the latest comes due", async () => {
    const { app, id, detail, remindAt } = await labWithCrashLoop();
    await setReminder(app, id, "2026-10-13T10:00:00Z");

    const response = await setReminder(app, id, "2026-10-13T12:00:00+02:00");

    expect(response.json().remindAt).toBe("2026-10-13T10:00:00.000Z");
    await setReminder(app, id, "2026-10-13T11:00:00Z");
    expect(await remindAt("2026-10-13T10:30:00Z")).toEqual([]);
    expect(await remindAt("2026-10-13T11:00:00Z")).toEqual([id]);
    expect(history(await detail()).map(([kind, , at]) => [kind, at])).toEqual([
      ["fired", null],
      ["reminder_set", "2026-10-13T10:00:00.000Z"],
      ["reminder_set", "2026-10-13T10:00:00.000Z"],
      ["reminder_set", "2026-10-13T11:00:00.000Z"],
      ["reminded", null],
    ]);
  });

  it("refuses a time that isn't in the future, or is over a year ahead", async () => {
    const { app, id, detail } = await labWithCrashLoop();

    for (const remindAt of ["2026-10-13T09:00:00Z", "2026-10-13T08:00:00Z"]) {
      const response = await setReminder(app, id, remindAt);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "A reminder must be in the future" });
    }
    const far = await setReminder(app, id, "2027-10-14T09:00:00Z");
    expect(far.statusCode).toBe(400);
    expect(far.json()).toEqual({ error: "A reminder can be at most a year ahead" });
    expect((await setReminder(app, id, "tomorrow morning")).statusCode).toBe(400);
    expect((await setReminder(app, id, "2026-10-14T06:00:00")).statusCode).toBe(400);
    expect(history(await detail())).toHaveLength(1);
  });

  it("is a 404 for an occurrence that doesn't exist", async () => {
    const { app, id } = await labWithCrashLoop();

    const response = await setReminder(app, id + 100, "2026-10-14T06:00:00Z");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Occurrence not found" });
  });
});

describe("DELETE /api/occurrences/{id}/reminder", () => {
  it("cancels the reminder, in the history, and it never comes due", async () => {
    const { app, id, detail, at, remindAt } = await labWithCrashLoop();
    await setReminder(app, id, "2026-10-14T06:00:00Z");
    at("2026-10-13T09:10:00Z");

    const response = await cancelReminder(app, id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, remindAt: null, lastEventKind: "fired" });
    expect(await remindAt("2026-10-14T07:00:00Z")).toEqual([]);
    expect(history(await detail())).toEqual([
      ["fired", "2026-10-13T08:30:00.000Z", null],
      ["reminder_set", "2026-10-13T09:00:00.000Z", "2026-10-14T06:00:00.000Z"],
      ["reminder_cancelled", "2026-10-13T09:10:00.000Z", null],
    ]);
  });

  it("does nothing, and is no error, without a reminder", async () => {
    const { app, id, detail } = await labWithCrashLoop();

    const response = await cancelReminder(app, id);

    expect(response.statusCode).toBe(200);
    expect(response.json().remindAt).toBeNull();
    expect(history(await detail())).toHaveLength(1);
  });

  it("is a 404 for an occurrence that doesn't exist", async () => {
    const { app, id } = await labWithCrashLoop();

    expect((await cancelReminder(app, id + 100)).statusCode).toBe(404);
  });
});

describe("a reminder coming due", () => {
  it("resurfaces the occurrence once: a reminded event, newest in the list", async () => {
    const { app, id, detail, remindAt } = await labWithCrashLoop();
    await setReminder(app, id, "2026-10-14T06:00:00Z");

    expect(await remindAt("2026-10-14T05:59:59.999Z")).toEqual([]);
    expect(await remindAt("2026-10-14T06:00:00Z")).toEqual([id]);
    expect(await remindAt("2026-10-14T06:00:30Z")).toEqual([]);

    const { occurrence, events } = await detail();
    expect(occurrence).toMatchObject({
      status: "firing",
      lastEventAt: "2026-10-14T06:00:00.000Z",
      lastEventKind: "reminded",
      remindAt: null,
    });
    expect(events.at(-1)).toMatchObject({ kind: "reminded", cause: null, remindAt: null });
    expect(await titles(app, "/api/occurrences")).toEqual([crashLoop.title, targetDown.title]);
  });

  it("still reminds of an occurrence that resolved meanwhile, as resolved", async () => {
    const { app, services, id, detail, remindAt } = await labWithCrashLoop();
    await setReminder(app, id, "2026-10-14T06:00:00Z");
    await deliver(services, [crashLoopResolved], "2026-10-13T12:00:00Z");

    expect(await remindAt("2026-10-14T06:00:00Z")).toEqual([id]);

    const { occurrence, events } = await detail();
    expect(occurrence).toMatchObject({ status: "resolved", lastEventKind: "reminded" });
    expect(events.map((event: { kind: string }) => event.kind)).toEqual([
      "fired",
      "reminder_set",
      "resolved",
      "reminded",
    ]);
  });

  it("keeps the reminder when the alert is resent before it is due", async () => {
    const { app, services, id, detail, remindAt } = await labWithCrashLoop();
    await setReminder(app, id, "2026-10-14T06:00:00Z");
    await deliver(services, [crashLoop], "2026-10-13T10:00:00Z");

    expect((await detail()).occurrence).toMatchObject({
      lastEventKind: "resent",
      remindAt: "2026-10-14T06:00:00.000Z",
    });
    expect(await remindAt("2026-10-14T06:00:00Z")).toEqual([id]);
  });

  it("comes due once on the first sweep after the server was down across its time", async () => {
    const { app, id, detail, remindAt } = await labWithCrashLoop();
    await setReminder(app, id, "2026-10-14T06:00:00Z");

    expect(await remindAt("2026-10-14T09:30:00Z")).toEqual([id]);
    expect(await remindAt("2026-10-14T09:30:30Z")).toEqual([]);

    expect((await detail()).occurrence.lastEventAt).toBe("2026-10-14T09:30:00.000Z");
  });

  it("comes due every reminder that is due, the longest overdue first", async () => {
    const { app, services, id, remindAt } = await labWithCrashLoop();
    const other = (await getJson(app, "/api/occurrences")).body.occurrences[0].id;
    await setReminder(app, id, "2026-10-14T07:00:00Z");
    await setReminder(app, other, "2026-10-14T06:00:00Z");
    await deliver(services, [], "2026-10-13T10:00:00Z");

    expect(await remindAt("2026-10-14T08:00:00Z")).toEqual([other, id]);
  });
});

describe("the change stream", () => {
  it("hears of a reminder set, cancelled or come due, and not of a sweep with nothing due", async () => {
    const { app, services, id, remindAt } = await labWithCrashLoop();
    const heard: string[] = [];
    services.changes.subscribe((kind) => heard.push(kind));

    await setReminder(app, id, "2026-10-13T10:00:00Z");
    expect(heard).toEqual(["occurrences"]);

    await remindAt("2026-10-13T09:30:00Z");
    expect(heard).toEqual(["occurrences"]);

    await remindAt("2026-10-13T10:00:00Z");
    expect(heard).toEqual(["occurrences", "occurrences"]);

    await setReminder(app, id, "2026-10-13T12:00:00Z");
    await cancelReminder(app, id);
    expect(heard).toHaveLength(4);
  });
});
