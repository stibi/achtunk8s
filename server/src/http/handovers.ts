import { z } from "zod";
import { claimWithinMs, maxActiveHandovers } from "../domain/handover.ts";
import type { Api, Handovers } from "./api-contract.ts";
import { errorBody } from "./api-schemas.ts";
import { handoverBody, handoverId, handoverStates, toHandoverBody } from "./handover-schemas.ts";

// What a client does with handovers (ADR 0022): ask for one, cancel it, read them. Open like
// the rest of the client API (ADR 0002); only the handler API takes a token (ADR 0023).

const id = z.coerce.number().int().positive();
const notFound = { error: "Handover not found" };

const createRequest = z.object({
  handler: handoverId.describe("The handler offering the action"),
  action: handoverId.describe("The action, as the occurrence's detail lists it"),
});

const pageBody = z
  .object({
    handovers: z.array(handoverBody),
    nextCursor: z
      .string()
      .nullable()
      .describe("Pass as cursor for the next page; null on the last"),
  })
  .meta({ id: "HandoverPage" });

// Opaque to clients: the id the page ended with.
const encodeCursor = (after: number) => Buffer.from(JSON.stringify(after)).toString("base64url");

function decodeCursor(cursor: string): number | null {
  try {
    const parsed = id.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function registerHandoverRoutes(api: Api, handovers: Handovers): void {
  api.post(
    "/api/occurrences/:id/handovers",
    {
      schema: {
        tags: ["client"],
        operationId: "createHandover",
        summary: "Hand the occurrence over to a handler's action",
        description:
          "Asks the handler to act on this alert, e.g. to investigate it. The handler takes it when it next asks for work. " +
          "While a handover of that action is requested or running for the occurrence, that one is returned (200) and nothing new is made. " +
          `One no handler takes within ${claimWithinMs / 60_000} minutes expires. ` +
          "404: no such occurrence. 409: no handler offers the action, it isn't for this alert, or its handler isn't connected. " +
          `503: ${maxActiveHandovers} handovers are requested or running already.`,
        params: z.object({ id }),
        body: createRequest,
        response: {
          200: handoverBody,
          201: handoverBody,
          400: errorBody,
          404: errorBody,
          409: errorBody,
          503: errorBody,
        },
      },
    },
    async (request, reply) => {
      const { handler, action } = request.body;
      const result = await handovers.create(request.params.id, handler, action);
      switch (result.kind) {
        case "created":
          return reply.code(201).send(toHandoverBody(result.handover));
        case "existing":
          return toHandoverBody(result.handover);
        case "not-found":
          return reply.code(404).send({ error: "Occurrence not found" });
        case "not-offered":
          return reply.code(409).send({ error: result.reason });
        case "busy":
          return reply.code(503).send({ error: "Too many handovers are requested or running" });
      }
    },
  );

  api.get(
    "/api/handovers",
    {
      schema: {
        tags: ["client"],
        operationId: "listHandovers",
        summary: "Every handover, newest first",
        description: "The record of what was handed over and what came back. Nothing is deleted.",
        querystring: z.object({
          state: z.enum(handoverStates).optional(),
          cursor: z.string().optional().describe("nextCursor from the previous page"),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: pageBody, 400: errorBody },
      },
    },
    async (request, reply) => {
      const { state, cursor, limit } = request.query;
      const after = cursor === undefined ? null : decodeCursor(cursor);
      if (after === null && cursor !== undefined) {
        return reply.code(400).send({ error: "Invalid cursor" });
      }
      const page = await handovers.list({ state: state ?? null, after, limit });
      return {
        handovers: page.handovers.map(toHandoverBody),
        nextCursor: page.next === null ? null : encodeCursor(page.next),
      };
    },
  );

  registerHandoverRoute(api, handovers);
}

function registerHandoverRoute(api: Api, handovers: Handovers): void {
  api.get(
    "/api/handovers/:id",
    {
      schema: {
        tags: ["client"],
        operationId: "getHandover",
        summary: "One handover",
        params: z.object({ id }),
        response: { 200: handoverBody, 400: errorBody, 404: errorBody },
      },
    },
    async (request, reply) => {
      const handover = await handovers.get(request.params.id);
      return handover === null ? reply.code(404).send(notFound) : toHandoverBody(handover);
    },
  );

  api.post(
    "/api/handovers/:id/cancel",
    {
      schema: {
        tags: ["client"],
        operationId: "cancelHandover",
        summary: "Cancel a handover that is requested or running",
        description:
          "It is cancelled at once. A handler working on it learns so from its next progress call and stops. " +
          "409: it has ended already.",
        params: z.object({ id }),
        response: { 200: handoverBody, 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => {
      const result = await handovers.cancel(request.params.id);
      switch (result.kind) {
        case "cancelled":
          return toHandoverBody(result.handover);
        case "not-found":
          return reply.code(404).send(notFound);
        case "ended":
          return reply.code(409).send({ error: `The handover is ${result.state} already` });
      }
    },
  );
}
