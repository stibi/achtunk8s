import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { ReminderResult } from "../services/reminders.ts";
import type { Api, Inbox } from "./api-contract.ts";
import { errorBody, occurrenceBody, timestamp, toOccurrenceBody } from "./api-schemas.ts";

const params = z.object({ id: z.coerce.number().int().positive() });
const response = { 200: occurrenceBody, 400: errorBody, 404: errorBody };

const reminderRequest = z.object({
  remindAt: timestamp.describe(
    "When to resurface the occurrence: in the future, at most a year ahead. The client turns " +
      "'tomorrow morning' into this instant in the user's time zone; the server stores instants only",
  ),
});

export function registerReminderRoutes(api: Api, inbox: Inbox): void {
  api.put(
    "/api/occurrences/:id/reminder",
    {
      schema: {
        tags: ["client"],
        operationId: "setOccurrenceReminder",
        summary: "Remind about the occurrence at a time: it resurfaces then",
        description:
          "Sets the occurrence's reminder, replacing one it has, and records a reminder_set event. " +
          "At remindAt the server records a reminded event, which moves lastEventAt, so every client " +
          "shows the occurrence as unread again and notifies, whatever its state by then. " +
          "There are no users, so the reminder is everyone's (ADR 0002, ADR 0025). " +
          "400: remindAt is not in the future, or over a year ahead.",
        params,
        body: reminderRequest,
        response,
      },
    },
    async (request, reply) =>
      answer(
        await inbox.setOccurrenceReminder(request.params.id, new Date(request.body.remindAt)),
        reply,
      ),
  );

  api.delete(
    "/api/occurrences/:id/reminder",
    {
      schema: {
        tags: ["client"],
        operationId: "cancelOccurrenceReminder",
        summary: "Cancel the occurrence's reminder",
        description:
          "Cancels the reminder pending on the occurrence and records a reminder_cancelled event. " +
          "Cancelling when none is pending is not an error, and records nothing (ADR 0025).",
        params,
        response,
      },
    },
    async (request, reply) =>
      answer(await inbox.cancelOccurrenceReminder(request.params.id), reply),
  );
}

function answer(result: ReminderResult, reply: FastifyReply) {
  switch (result.kind) {
    case "changed":
      return toOccurrenceBody(result.occurrence);
    case "not-found":
      return reply.code(404).send({ error: "Occurrence not found" });
    case "invalid":
      return reply.code(400).send({ error: result.reason });
  }
}
