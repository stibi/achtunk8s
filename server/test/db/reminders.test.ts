import { describe, expect, it } from "vitest";
import { findOccurrence, listEvents, listFiringOccurrences } from "../../src/db/queries.ts";
import { remindOneDue, setReminder } from "../../src/db/reminders.ts";
import { parseChannelSlug, parseInstanceName } from "../../src/domain/channel.ts";
import { ingestNotification } from "../../src/services/ingest.ts";
import { crashLoop, crashLoopResolved } from "../api.ts";
import { createTestDatabase, openConnections } from "../database.ts";

// The atomic claim behind ADR 0025: servers sweeping at once fire a reminder once.

async function crashLoopWithReminder() {
  const connection = await createTestDatabase();
  const { db } = connection;
  const deliver = (alert: typeof crashLoop, at: string) =>
    ingestNotification(db, {
      source: "alertmanager",
      channel: {
        instance: parseInstanceName("lab"),
        slug: parseChannelSlug("example-prod"),
      } as Parameters<typeof ingestNotification>[1]["channel"],
      alerts: [alert],
      receiver: null,
      receivedAt: new Date(at),
    });
  await deliver(crashLoop, "2026-10-13T09:00:00Z");
  const [occurrence] = await listFiringOccurrences(db);
  if (occurrence === undefined) {
    throw new Error("crashLoop isn't firing");
  }
  await db.transaction((tx) =>
    setReminder(
      tx,
      occurrence.id,
      new Date("2026-10-13T10:00:00Z"),
      new Date("2026-10-13T09:00:00Z"),
    ),
  );
  return { connection, db, occurrence, deliver };
}

describe("remindOneDue", () => {
  it("never moves lastEventAt back, when an ingest recorded a later event meanwhile", async () => {
    const { db, occurrence, deliver } = await crashLoopWithReminder();
    // The sweep read its clock, then waited while this resolve held the occurrence.
    await deliver(crashLoopResolved, "2026-10-13T10:00:05Z");

    await remindOneDue(db, new Date("2026-10-13T10:00:00Z"));

    const found = await findOccurrence(db, occurrence.id);
    expect(found).toMatchObject({
      status: "resolved",
      lastEventKind: "reminded",
      lastEventAt: new Date("2026-10-13T10:00:05Z"),
    });
  });

  it("fires a due reminder once when several sweeps claim it at the same time", async () => {
    const { connection, db, occurrence } = await crashLoopWithReminder();
    await openConnections(connection, 4);

    const claims = await Promise.all(
      Array.from({ length: 4 }, () => remindOneDue(db, new Date("2026-10-13T10:00:00Z"))),
    );

    expect(claims.filter((claim) => claim !== null)).toEqual([occurrence.id]);
    expect((await listEvents(db, occurrence.id)).map((event) => event.kind)).toEqual([
      "fired",
      "reminder_set",
      "reminded",
    ]);
  });
});
