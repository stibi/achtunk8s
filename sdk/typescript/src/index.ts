// Write a plugin for Achtung: a handler that takes alerts handed over to it (ADR 0022).
// The protocol is in docs/handover-protocol.md and api/openapi.yaml.

export { agentReport } from "./agent-report.ts";
export type { Answered, Claim, ClientOptions, HandlerClient } from "./client.ts";
export { HandlerApiError, handlerClient } from "./client.ts";
export type {
  ActionRegistration,
  ActionScope,
  ClaimedHandover,
  HandoverLink,
  HandoverResult,
  HandoverState,
  Occurrence,
  OccurrenceEvent,
  Registration,
  Severity,
} from "./protocol.ts";
export type { Action, HandleContext, HandlerEvent, HandlerOptions } from "./run-handler.ts";
export { HandoverStopped, runHandler } from "./run-handler.ts";
