import { z } from "zod";
import { type Handover, handoverIdRule } from "../domain/handover.ts";
import type { ActionOffer } from "../services/handovers.ts";
import { timestamp } from "./api-schemas.ts";

// The JSON shapes of handovers (ADR 0022), for the client routes and the handler API.

export const handoverId = z
  .string()
  .regex(new RegExp(handoverIdRule), "lowercase letters, digits and dashes, at most 63");

export const handoverStates = [
  "requested",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
] as const;

const linkBody = z.object({
  title: z.string(),
  url: z.string().describe("An http or https URL"),
});

export const handoverBody = z
  .object({
    id: z.int().positive(),
    occurrenceId: z.int().positive(),
    handler: z.string().describe("The id of the handler it was handed to"),
    handlerName: z.string().describe("The handler's name when it was asked"),
    handlerVersion: z.string(),
    action: z.string().describe("The id of the handler's action"),
    title: z.string().describe("The action's title when it was asked"),
    state: z
      .enum(handoverStates)
      .describe(
        "requested: waiting for its handler. running: a handler took it. succeeded, failed: the handler's result; " +
          "failed also when the handler stopped answering. cancelled: by a client. timed_out: it ran past its deadline. " +
          "expired: no handler took it within 10 minutes",
      ),
    requestedAt: timestamp,
    claimedAt: timestamp.nullable().describe("When a handler took it; null when none did"),
    deadlineAt: timestamp.nullable().describe("While running: when it times out. Null otherwise"),
    finishedAt: timestamp
      .nullable()
      .describe("Set exactly when it is neither requested nor running"),
    summary: z.string().nullable().describe("Succeeded: the result in one line of plain text"),
    body: z
      .string()
      .nullable()
      .describe(
        "Succeeded: the result as Markdown. Text from another program: render it as text, load nothing remote from it",
      ),
    links: z.array(linkBody).describe("Succeeded: what the result points to; empty otherwise"),
    error: z.string().nullable().describe("Failed: why"),
    progress: z
      .array(z.object({ at: timestamp, message: z.string() }))
      .describe("What the handler reported while working, oldest first"),
  })
  .meta({ id: "Handover" });

export const actionOfferBody = z
  .object({
    handler: z.string().describe("The id of the handler offering it"),
    handlerName: z.string(),
    action: z.string().describe("The action's id, unique within its handler"),
    title: z.string().describe("What the button says"),
    description: z.string().describe("The button's help text"),
    available: z
      .boolean()
      .describe("Whether the handler is connected; a handover for one that isn't is refused"),
    lastSeenAt: timestamp.describe("The handler's last call"),
  })
  .meta({ id: "ActionOffer" });

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function toHandoverBody(handover: Handover): z.infer<typeof handoverBody> {
  const { id, occurrenceId, handler, handlerName, handlerVersion, action, title, state } = handover;
  return {
    ...{ id, occurrenceId, handler, handlerName, handlerVersion, action, title, state },
    requestedAt: handover.requestedAt.toISOString(),
    claimedAt: "claimedAt" in handover ? iso(handover.claimedAt) : null,
    deadlineAt: handover.state === "running" ? iso(handover.deadlineAt) : null,
    finishedAt: "finishedAt" in handover ? iso(handover.finishedAt) : null,
    summary: handover.state === "succeeded" ? handover.summary : null,
    body: handover.state === "succeeded" ? handover.body : null,
    links: handover.state === "succeeded" ? [...handover.links] : [],
    error: handover.state === "failed" ? handover.error : null,
    progress: handover.progress.map(({ at, message }) => ({ at: at.toISOString(), message })),
  };
}

export function toActionOfferBody(offer: ActionOffer): z.infer<typeof actionOfferBody> {
  return { ...offer, lastSeenAt: offer.lastSeenAt.toISOString() };
}
