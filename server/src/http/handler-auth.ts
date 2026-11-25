import type { FastifyReply, FastifyRequest } from "fastify";
import { sameSecret } from "../services/secrets.ts";

/** Each handler's token, by handler id (ADR 0023); null when handlers need none. */
export type HandlerTokens = ReadonlyMap<string, string> | null;

const identities = new WeakMap<FastifyRequest, string>();

/** The handler the request's token names; null when tokens aren't required. */
export function authenticatedHandler(request: FastifyRequest): string | null {
  return identities.get(request) ?? null;
}

/**
 * The check every handler route runs first when tokens are configured: the request must
 * carry one handler's token as a bearer token. Tokens are compared in constant time and
 * never logged.
 */
export function requireHandlerToken(tokens: HandlerTokens) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (tokens === null) {
      return;
    }
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    let handler: string | undefined;
    for (const [id, token] of tokens) {
      // Every token is compared, so the time taken doesn't tell which one matched.
      if (given !== undefined && sameSecret(given, token)) {
        handler = id;
      }
    }
    if (handler === undefined) {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ error: "A handler token is required" });
    }
    identities.set(request, handler);
  };
}

/** Whether the request may act as `handler`: tokens aren't required, or its token is that handler's. */
export function mayActAs(request: FastifyRequest, handler: string): boolean {
  const authenticated = authenticatedHandler(request);
  return authenticated === null || authenticated === handler;
}
