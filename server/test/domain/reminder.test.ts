import { describe, expect, it } from "vitest";
import { longestReminderMs, reminderProblem } from "../../src/domain/reminder.ts";

const now = new Date("2026-10-13T09:00:00Z");
const ahead = (ms: number) => new Date(now.getTime() + ms);

describe("reminderProblem", () => {
  it("accepts any time in the future, up to a year ahead", () => {
    expect(reminderProblem(ahead(1), now)).toBeNull();
    expect(reminderProblem(ahead(longestReminderMs), now)).toBeNull();
  });

  it("refuses now and the past", () => {
    expect(reminderProblem(now, now)).toBe("A reminder must be in the future");
    expect(reminderProblem(ahead(-60_000), now)).toBe("A reminder must be in the future");
  });

  it("refuses more than a year ahead", () => {
    expect(longestReminderMs).toBe(365 * 24 * 3600 * 1000);
    expect(reminderProblem(ahead(longestReminderMs + 1), now)).toBe(
      "A reminder can be at most a year ahead",
    );
  });
});
