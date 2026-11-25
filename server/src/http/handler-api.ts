import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { leaseMs, maxHandlers } from "../domain/handover.ts";
import type { Changes } from "../services/changes.ts";
import type { Api, Handovers } from "./api-contract.ts";
import { errorBody, occurrenceDetailFields, toOccurrenceDetailFields } from "./api-schemas.ts";
import { type ClaimWaitOptions, claimWaits } from "./claim-wait.ts";
import { type HandlerTokens, mayActAs, requireHandlerToken } from "./handler-auth.ts";
import { registerClaimedHandoverRoutes } from "./handler-handovers.ts";
import { claimFields, handlerBody, registrationRequest } from "./handler-schemas.ts";
import { handoverId } from "./handover-schemas.ts";

// The handler API (ADR 0022): what a plugin's process calls to offer actions and take
// handovers. Public and versioned in its path; v0 may still change. With HANDLER_TOKENS
// set, every route needs the handler's bearer token (ADR 0023).

export interface HandlerApiOptions {
  readonly tokens: HandlerTokens;
  readonly claims?: ClaimWaitOptions;
}

const tags = () => ["handler"];
const params = z.object({ handler: handoverId });
const anotherHandler = { error: "The token belongs to another handler" };
const authErrors = { 401: errorBody, 403: errorBody };
const withToken =
  "With handler tokens configured: 401 without a valid bearer token, 403 when it is another handler's.";

const claimedBody = z
  .object({ ...claimFields, ...occurrenceDetailFields })
  .describe(
    "A handover, now this handler's to run, with the occurrence as GET /api/occurrences/{id} returns it. " +
      "Alert labels and annotations are untrusted text written by other systems",
  )
  .meta({ id: "ClaimedHandover" });

export function registerHandlerRoutes(
  app: FastifyInstance,
  handovers: Handovers,
  changes: Changes,
  options: HandlerApiOptions,
): void {
  const waits = claimWaits(app, changes, options.claims ?? {});
  // Its own plugin, so the hooks cover these routes only.
  app.register(async (scope) => {
    scope.addHook("onRequest", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });
    scope.addHook("onRequest", requireHandlerToken(options.tokens));
    const api = scope.withTypeProvider<ZodTypeProvider>();
    registerRegistrationRoutes(api, handovers, options.tokens);
    registerClaimRoute(api, handovers, waits);
    registerClaimedHandoverRoutes(api, handovers);
  });
}

function registerRegistrationRoutes(api: Api, handovers: Handovers, tokens: HandlerTokens): void {
  api.put(
    "/api/handler/v0/handlers/:handler",
    {
      schema: {
        tags: tags(),
        operationId: "registerHandler",
        summary: "Register a handler and the actions it offers",
        description:
          "Call it at startup, again when the actions change, and after a claim answered 404. It replaces the handler's earlier registration. " +
          "Each action becomes a button on the alerts it applies to, enabled while the handler keeps calling. " +
          `409: ${maxHandlers} handlers are registered already. ${withToken}`,
        params,
        body: registrationRequest,
        response: { 200: handlerBody, 400: errorBody, ...authErrors, 409: errorBody },
      },
    },
    async (request, reply) => {
      const { handler } = request.params;
      if (!mayActAs(request, handler)) {
        return reply.code(403).send(anotherHandler);
      }
      const actions = request.body.actions.map(({ appliesTo, ...action }) => ({
        ...action,
        appliesTo: {
          instances: appliesTo.instances ?? [],
          severities: appliesTo.severities ?? [],
          labels: appliesTo.labels ?? {},
        },
      }));
      const { name, version } = request.body;
      const result = await handovers.register(handler, { name, version, actions });
      if (result.kind === "too-many") {
        return reply.code(409).send({ error: "Too many handlers are registered" });
      }
      if (tokens === null) {
        request.log.warn(
          { handler },
          "a handler registered without a token: set HANDLER_TOKENS (ADR 0023)",
        );
      }
      return { id: handler, name, version, actions };
    },
  );

  api.delete(
    "/api/handler/v0/handlers/:handler",
    {
      schema: {
        tags: tags(),
        operationId: "removeHandler",
        summary: "Forget a handler",
        description: `Its actions are no longer offered. Its handovers stay. Removing an unknown handler is not an error. ${withToken}`,
        params,
        response: { 204: z.null().describe("Forgotten"), 400: errorBody, ...authErrors },
      },
    },
    async (request, reply) => {
      if (!mayActAs(request, request.params.handler)) {
        return reply.code(403).send(anotherHandler);
      }
      await handovers.remove(request.params.handler);
      return reply.code(204).send(null);
    },
  );
}

function registerClaimRoute(
  api: Api,
  handovers: Handovers,
  waits: ReturnType<typeof claimWaits>,
): void {
  api.post(
    "/api/handler/v0/handlers/:handler/claim",
    {
      schema: {
        tags: tags(),
        operationId: "claimHandover",
        summary: "Take the handler's next handover, waiting for one if asked",
        description:
          "Answers at once with the oldest handover requested of this handler, which is then running and this handler's alone: it is given out at most once and never again. " +
          "With none waiting, the request is held for up to `wait` seconds and answered as soon as one arrives, else with 204. " +
          "Every call counts as the handler being connected. Keep calling in a loop. " +
          "404: the handler isn't registered; register, then claim again. 503: too many claims are waiting; try again after a pause. " +
          withToken,
        params,
        querystring: z.object({
          wait: z.coerce
            .number()
            .int()
            .min(0)
            .max(30)
            .default(10)
            .describe(
              "Seconds to wait for a handover. Over 10 needs a gateway that doesn't cut requests off at 15 s",
            ),
        }),
        response: {
          200: claimedBody,
          204: z.null().describe("Nothing to do"),
          ...authErrors,
          400: errorBody,
          404: errorBody,
          503: errorBody,
        },
      },
    },
    async (request, reply) => {
      const { handler } = request.params;
      if (!mayActAs(request, handler)) {
        return reply.code(403).send(anotherHandler);
      }
      const waited = await waits.wait(
        async () => {
          const result = await handovers.claim(handler);
          return result.kind === "none" ? null : result;
        },
        request.query.wait * 1000,
        request.raw.socket,
      );
      if (waits.isClosing()) {
        reply.header("connection", "close");
      }
      if (waited.kind === "too-many-waiting") {
        return reply.code(503).send({ error: "Too many claims are waiting" });
      }
      if (waited.kind !== "found") {
        return reply.code(204).send(null);
      }
      if (waited.value.kind === "unknown-handler") {
        return reply.code(404).send({ error: "Handler not registered" });
      }
      const { handover, claimToken, detail } = waited.value;
      return {
        id: handover.id,
        action: handover.action,
        claimToken,
        leaseSeconds: leaseMs / 1000,
        deadlineAt: handover.deadlineAt.toISOString(),
        requestedAt: handover.requestedAt.toISOString(),
        ...toOccurrenceDetailFields(detail),
      };
    },
  );
}
