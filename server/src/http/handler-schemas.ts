import { z } from "zod";
import { severity, timestamp } from "./api-schemas.ts";
import { handoverId } from "./handover-schemas.ts";

// The handler API's own JSON shapes (ADR 0022): what a plugin sends and gets.

// Postgres text can't hold a NUL, and its JSON no broken surrogate pair: refused here, at
// the boundary, as invalid input. Handlers pass on what agents and commands printed.
const text = z.string().refine((value) => !value.includes("\0") && value.isWellFormed(), {
  message: "must not contain NUL or broken characters",
});

const actionFields = {
  id: handoverId.describe("Unique within the handler"),
  title: text.trim().min(1).max(40).describe("What the button says"),
  description: text.trim().max(200).describe("The button's help text"),
  timeoutSeconds: z
    .int()
    .min(60)
    .max(3600)
    .describe("How long one handover may run before it times out"),
};

const appliesTo = z
  .object({
    instances: z.array(text.min(1)).min(1).max(50).optional(),
    severities: z.array(severity).min(1).optional(),
    labels: z
      .record(text, text)
      .optional()
      .describe("Each label must be there with exactly this value"),
  })
  .describe("Which alerts the action is for. Every part given must match; none given: every alert");

export const registrationRequest = z.object({
  name: text.trim().min(1).max(60).describe("Shown in the client"),
  version: text.trim().min(1).max(40).describe("The handler's own version"),
  actions: z
    .array(
      z.object({
        ...actionFields,
        description: actionFields.description.default(""),
        timeoutSeconds: actionFields.timeoutSeconds.default(900),
        appliesTo: appliesTo.default({}),
      }),
    )
    .min(1)
    .max(10)
    .refine((actions) => new Set(actions.map((action) => action.id)).size === actions.length, {
      message: "action ids must differ",
    }),
});

export const handlerBody = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    actions: z.array(
      z.object({
        ...actionFields,
        appliesTo: z.object({
          instances: z.array(z.string()).describe("Empty: every instance"),
          severities: z.array(severity).describe("Empty: every severity"),
          labels: z.record(z.string(), z.string()),
        }),
      }),
    ),
  })
  .describe("The handler as registered, with defaults filled in")
  .meta({ id: "AlertHandler" });

export const progressRequest = z
  .object({
    message: text
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("A status line for the client; without one the call only renews the lease"),
  })
  // A call without a body only renews the lease.
  .nullish();

/** An http or https URL without credentials, or null. */
function webUrl(value: string): URL | null {
  const url = URL.canParse(value) ? new URL(value) : null;
  return url !== null &&
    /^https?:$/.test(url.protocol) &&
    url.username === "" &&
    url.password === ""
    ? url
    : null;
}

const link = z.object({
  title: text.trim().min(1).max(100),
  url: z
    .string()
    .max(2000)
    .refine((url) => webUrl(url) !== null, {
      message: "an http or https URL, without credentials",
    })
    // Stored as parsed, so every client reads the URL the check saw.
    .transform((url) => webUrl(url)?.href ?? url),
});

export const resultRequest = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("succeeded"),
    summary: text
      .trim()
      .min(1)
      .max(300)
      .regex(/^[^\r\n]*$/, "one line")
      .describe("One line of plain text"),
    body: text.max(65_536).describe("Markdown; rendered as text"),
    links: z.array(link).max(10).default([]),
  }),
  z.object({
    outcome: z.literal("failed"),
    error: text.trim().min(1).max(2000).describe("Why, for the person who asked"),
  }),
]);

/** What a claim hands over, next to the occurrence's detail fields. */
export const claimFields = {
  id: z.int().positive().describe("The handover"),
  action: z.string().describe("Which of the handler's actions was asked for"),
  claimToken: z
    .string()
    .describe("Send it as the Achtung-Claim header with every later call for this handover"),
  leaseSeconds: z
    .int()
    .positive()
    .describe("Call progress at least this often, or the handover fails as handler lost"),
  deadlineAt: timestamp.describe("When the handover times out"),
  requestedAt: timestamp,
};
