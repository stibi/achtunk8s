import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { ChannelAddress } from "../domain/channel.ts";
import type { Handover, HandoverResult } from "../domain/handover.ts";
import type { MetricPanelId } from "../domain/metrics.ts";
import type { Occurrence } from "../domain/occurrence.ts";
import type { AlertmanagerSilenceResult } from "../services/alertmanager-silences.ts";
import type {
  Claimant,
  ClaimResult,
  HandlerRegistration,
  ProgressResult,
  RegisterHandlerResult,
  ResultResult,
} from "../services/handover-claims.ts";
import type {
  ActionOffer,
  CancelHandoverResult,
  CreateHandoverResult,
  HandoverFilter,
  HandoverPage,
} from "../services/handovers.ts";
import type { AlertmanagerAlertList, Home } from "../services/home.ts";
import type {
  ChannelOccurrencePage,
  ChannelOverview,
  OccurrenceDetail,
  OccurrenceFilter,
  OccurrencePage,
} from "../services/inbox.ts";
import type { OccurrenceGraphResult } from "../services/metrics.ts";
import type { ReminderResult } from "../services/reminders.ts";
import type { SilenceResult } from "../services/silences.ts";

/** Handing alerts over to plugins (ADR 0022): what clients and handlers do. */
export interface Handovers {
  /** The actions offered for an occurrence and its handovers, newest first. */
  of(occurrence: Occurrence): Promise<{
    readonly actions: readonly ActionOffer[];
    readonly handovers: readonly Handover[];
  }>;
  create(occurrenceId: number, handler: string, action: string): Promise<CreateHandoverResult>;
  cancel(id: number): Promise<CancelHandoverResult>;
  get(id: number): Promise<Handover | null>;
  list(filter: HandoverFilter): Promise<HandoverPage>;
  register(handler: string, registration: HandlerRegistration): Promise<RegisterHandlerResult>;
  remove(handler: string): Promise<void>;
  /** The handler's oldest waiting handover, now its to run; `none` when nothing waits. */
  claim(handler: string): Promise<ClaimResult>;
  progress(id: number, claimant: Claimant, message: string | null): Promise<ProgressResult>;
  answer(id: number, claimant: Claimant, result: HandoverResult): Promise<ResultResult>;
}

/** The inbox's use cases, as the client API needs them. */
export interface Inbox {
  readonly handovers: Handovers;
  listChannels(): Promise<ChannelOverview[]>;
  listChannelOccurrences(
    channel: ChannelAddress,
    filter: OccurrenceFilter,
  ): Promise<ChannelOccurrencePage>;
  listOccurrences(filter: OccurrenceFilter): Promise<OccurrencePage>;
  getOccurrence(id: number): Promise<OccurrenceDetail | null>;
  /** A graph of what the occurrence's alert is about (ADR 0026). */
  getOccurrenceGraph(id: number, panel: MetricPanelId): Promise<OccurrenceGraphResult>;
  silenceOccurrence(id: number, durationSeconds: number): Promise<SilenceResult>;
  unsilenceOccurrence(id: number): Promise<SilenceResult>;
  /** Sets or replaces the occurrence's reminder (ADR 0025). */
  setOccurrenceReminder(id: number, remindAt: Date): Promise<ReminderResult>;
  cancelOccurrenceReminder(id: number): Promise<ReminderResult>;
  silenceAlertmanagerAlerts(
    instance: string,
    fingerprints: readonly string[],
    durationSeconds: number,
  ): Promise<AlertmanagerSilenceResult>;
  getHome(): Promise<Home>;
  /** The alerts behind an Alertmanager's tile; null when the instance has none. */
  listAlertmanagerAlerts(instance: string): Promise<AlertmanagerAlertList | null>;
  /** The alert names the Home views leave out, sorted (ADR 0011). */
  getIgnoredAlertNames(): Promise<string[]>;
  /** Replaces them with `names` and returns them as stored, sorted. */
  setIgnoredAlertNames(names: readonly string[]): Promise<string[]>;
}

/** The app with Zod schemas typing each route's request and reply. */
export type Api = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;
