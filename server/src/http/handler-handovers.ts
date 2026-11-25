import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { leaseMs, maxProgressEntries } from "../domain/handover.ts";
import type { Claimant } from "../services/handover-claims.ts";
import type { Api, Handovers } from "./api-contract.ts";
import { errorBody } from "./api-schemas.ts";
import { authenticatedHandler } from "./handler-auth.ts";
import { progressRequest, resultRequest } from "./handler-schemas.ts";
import { handoverBody, handoverStates, toHandoverBody } from "./handover-schemas.ts";

// What a handler does with a handover it claimed (ADR 0022): keep it alive and answer it.
// Both calls carry the claim token, which only the claiming handler has.

const params = z.object({ id: z.coerce.number().int().positive() });
const notFound = { error: "Handover not found" };
const notTheClaimant = { error: "This handover isn't held with that claim token" };
const claimHeader =
  "Send the claim token as the Achtung-Claim header. 403: it is missing or not this handover's";

/** The claim token the request carries, with the handler its bearer token names. */
function claimantOf(request: FastifyRequest): Claimant | null {
  const claimToken = request.headers["achtung-claim"];
  return typeof claimToken === "string" && claimToken !== ""
    ? { claimToken, handler: authenticatedHandler(request) }
    : null;
}

export function registerClaimedHandoverRoutes(api: Api, handovers: Handovers): void {
  api.post(
    "/api/handler/v0/handovers/:id/progress",
    {
      schema: {
        tags: ["handler"],
        operationId: "reportHandoverProgress",
        summary: "Keep a claimed handover alive, with a status line if there is one",
        description:
          "Renews the handover's lease, and records the message for the client to show. " +
          `Up to ${maxProgressEntries} messages are kept; later ones only renew the lease. ` +
          "The answer says where the handover is: anything but running means stop working on it, " +
          `e.g. cancelled by a client. ${claimHeader}.`,
        params,
        body: progressRequest,
        response: {
          200: z.object({
            state: z.enum(handoverStates),
            leaseSeconds: z.int().positive().describe("Call again within this long"),
          }),
          400: errorBody,
          401: errorBody,
          403: errorBody,
          404: errorBody,
        },
      },
    },
    async (request, reply) => {
      const claimant = claimantOf(request);
      if (claimant === null) {
        return reply.code(403).send(notTheClaimant);
      }
      const message = request.body?.message ?? null;
      const result = await handovers.progress(request.params.id, claimant, message);
      switch (result.kind) {
        case "ok":
          return { state: result.state, leaseSeconds: leaseMs / 1000 };
        case "not-found":
          return reply.code(404).send(notFound);
        case "not-the-claimant":
          return reply.code(403).send(notTheClaimant);
      }
    },
  );
  registerResultRoute(api, handovers);
}

function registerResultRoute(api: Api, handovers: Handovers): void {
  api.post(
    "/api/handler/v0/handovers/:id/result",
    {
      schema: {
        tags: ["handler"],
        operationId: "answerHandover",
        summary: "End a claimed handover with its result",
        description:
          "succeeded, with a one-line summary, a Markdown body and links, or failed, with the reason. " +
          "The same result sent again is answered as before. " +
          `409: the handover ended another way first (cancelled, timed out, handler lost) or with a different result. ${claimHeader}.`,
        params,
        body: resultRequest,
        response: {
          200: handoverBody,
          400: errorBody,
          401: errorBody,
          403: errorBody,
          404: errorBody,
          409: errorBody,
        },
      },
    },
    async (request, reply) => {
      const claimant = claimantOf(request);
      if (claimant === null) {
        return reply.code(403).send(notTheClaimant);
      }
      const result = await handovers.answer(request.params.id, claimant, request.body);
      switch (result.kind) {
        case "ended":
          return toHandoverBody(result.handover);
        case "not-found":
          return reply.code(404).send(notFound);
        case "not-the-claimant":
          return reply.code(403).send(notTheClaimant);
        case "conflict":
          return reply.code(409).send({ error: `The handover is ${result.state} already` });
      }
    },
  );
}
