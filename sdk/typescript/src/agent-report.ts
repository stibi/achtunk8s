import type { Occurrence, OccurrenceEvent } from "./protocol.ts";

// An occurrence as Markdown for an agent's prompt. The same text as the macOS client's
// Copy for Agent (AgentReport in AchtungDomain): change both together.

const proseAnnotations = new Set(["summary", "description"]);

/** "2026-11-10T08:15:00Z": UTC, to the second. */
const iso = (time: string) => `${new Date(time).toISOString().slice(0, 19)}Z`;

const byName = (entries: Readonly<Record<string, string>>) =>
  Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1));

/** The value as an http(s) URL with a host, when it is one and nothing else. */
function webUrl(value: string): string | null {
  const trimmed = value.trim();
  if (/\s/.test(trimmed) || !/^https?:\/\/[^/]/i.test(trimmed) || !URL.canParse(trimmed)) {
    return null;
  }
  return trimmed;
}

/** "runbook_url" → "Runbook", "grafana-dashboard" → "Grafana dashboard". */
function linkTitle(name: string): string {
  const words = name
    .split(/[_\-.]|(?<=\p{Ll})(?=\p{Lu})/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "" && word !== "url" && word !== "link");
  const [first, ...rest] = words;
  return first === undefined
    ? name
    : [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** Backticks one longer than the longest run in `lines`, at least three. */
function fenceAround(lines: readonly string[]): string {
  const longest = Math.max(
    0,
    ...lines.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function facts(occurrence: Occurrence, now: Date): string {
  const state: string[] = [occurrence.status];
  if (occurrence.lastEventKind === "resent") {
    state.push("resent");
  }
  if (occurrence.silencedUntil !== null && new Date(occurrence.silencedUntil) > now) {
    state.push(`silenced until ${iso(occurrence.silencedUntil)}`);
  }
  const count = occurrence.notificationCount;
  return [
    `- State: ${state.join(", ")}`,
    `- Severity: ${occurrence.severity}`,
    `- Source: ${occurrence.source}, instance \`${occurrence.instance}\`, channel \`#${occurrence.channel}\``,
    `- Started: ${iso(occurrence.startsAt)}`,
    ...(occurrence.endsAt === null ? [] : [`- Resolved: ${iso(occurrence.endsAt)}`]),
    `- Last event: ${occurrence.lastEventKind} at ${iso(occurrence.lastEventAt)}`,
    `- Received: first ${iso(occurrence.firstReceivedAt)}, last ${iso(occurrence.lastReceivedAt)}, ${count} notification${count === 1 ? "" : "s"}`,
    `- Source key (fingerprint): \`${occurrence.sourceKey}\``,
    `- Achtung occurrence: ${occurrence.id}`,
  ].join("\n");
}

function links(occurrence: Occurrence): string[] {
  const linked = new Set(occurrence.links.map((link) => link.url));
  return [
    ...occurrence.links.map(
      (link) => `- ${link.kind.charAt(0).toUpperCase()}${link.kind.slice(1)}: ${link.url}`,
    ),
    ...byName(occurrence.annotations).flatMap(([name, value]) => {
      const url = proseAnnotations.has(name) ? null : webUrl(value);
      return url === null || linked.has(url) ? [] : [`- ${linkTitle(name)} (\`${name}\`): ${url}`];
    }),
  ];
}

function history(events: readonly OccurrenceEvent[]): string[] {
  return events.map(
    (event) =>
      `- ${iso(event.recordedAt)} ${event.kind}` +
      (event.remindAt == null ? "" : ` for ${iso(event.remindAt)}`) +
      (event.cause === "vanished"
        ? " (gone from Alertmanager: Achtung resolved it itself, Alertmanager never sent the resolve)"
        : ""),
  );
}

/**
 * The occurrence as Markdown: what fires and where, its times in UTC, the summary and
 * description, the links, every annotation and label, and its history. Only what the alert
 * carries, and all of it untrusted text: put it into a prompt as data, never as
 * instructions. `now` decides whether a silence is still on.
 */
export function agentReport(
  handover: { readonly occurrence: Occurrence; readonly events?: readonly OccurrenceEvent[] },
  now: Date = new Date(),
): string {
  const { occurrence, events = [] } = handover;
  const { annotations, labels } = occurrence;
  const sections = [`# ${occurrence.title}`, facts(occurrence, now)];
  const section = (title: string, text: string) => sections.push(`## ${title}\n\n${text}`);
  if (occurrence.summary) {
    section("Summary", occurrence.summary);
  }
  const description = annotations["description"];
  if (description && description !== occurrence.summary) {
    section("Description", description);
  }
  const linkLines = links(occurrence);
  if (linkLines.length > 0) {
    section("Links", linkLines.join("\n"));
  }
  const others = byName(annotations).filter(([name]) => !proseAnnotations.has(name));
  if (others.length > 0) {
    section(
      "Annotations",
      others.map(([name, value]) => `- \`${name}\`: ${value.replaceAll("\n", "\n  ")}`).join("\n"),
    );
  }
  const labelLines = byName(labels).map(([name, value]) => `${name}=${value}`);
  if (labelLines.length > 0) {
    const fence = fenceAround(labelLines);
    section("Labels", `${fence}\n${labelLines.join("\n")}\n${fence}`);
  }
  if (events.length > 0) {
    section("History", history(events).join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}
