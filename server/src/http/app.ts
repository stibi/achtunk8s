import fastifySwagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Config } from "../config.ts";
import type { Changes } from "../services/changes.ts";
import type { SourceAdapter } from "../sources/source-adapter.ts";
import { type Inbox, registerApiRoutes } from "./api.ts";
import { type EventStreamOptions, registerEventRoutes } from "./events.ts";
import { type HandlerApiOptions, registerHandlerRoutes } from "./handler-api.ts";
import { registerHealthRoutes } from "./health.ts";
import { type Ingest, registerIngestRoutes } from "./ingest.ts";
import { openApiTransform, openApiTransformObject } from "./openapi.ts";

/** The use cases the routes call; src/main.ts binds them to the database. */
export type Services = Inbox & { readonly ingest: Ingest; readonly changes: Changes };

export interface AppOptions {
  readonly logLevel: Config["logLevel"] | "silent";
  readonly sources: readonly SourceAdapter[];
  readonly services: Services;
  readonly checkReady: () => Promise<void>;
  /** Where log lines go; stdout when absent. Tests pass a stream to assert on logs. */
  readonly logStream?: { write(line: string): void };
  /** The change stream's timing and limit; its defaults otherwise. */
  readonly events?: EventStreamOptions;
  /** The handler API's tokens (ADR 0023) and its claim waits; no tokens when absent. */
  readonly handlers?: HandlerApiOptions;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const logger =
    options.logStream === undefined
      ? { level: options.logLevel }
      : { level: options.logLevel, stream: options.logStream };
  const app = Fastify({ logger });

  // Zod route schemas validate requests and responses, and generate the OpenAPI document.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: error.message });
    }
    // Client errors Fastify raises itself, e.g. a body that is not JSON: keep the reason.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (error as Error).message });
    }
    throw error;
  });
  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Achtung",
        description:
          "Self-hosted alert inbox. No authentication (ADR 0002), except that the handler API can require a token (ADR 0023).",
        version: "0.1.0",
      },
    },
    transform: openApiTransform,
    transformObject: openApiTransformObject,
  });

  // Registered as a plugin, after swagger, so swagger sees every route.
  app.register(async (routes) => {
    registerHealthRoutes(routes, options.checkReady);
    registerIngestRoutes(routes, options.sources, options.services.ingest);
    registerApiRoutes(routes, options.services);
    registerEventRoutes(routes, options.services.changes, options.events);
    registerHandlerRoutes(
      routes,
      options.services.handovers,
      options.services.changes,
      options.handlers ?? { tokens: null },
    );
  });
  return app;
}
