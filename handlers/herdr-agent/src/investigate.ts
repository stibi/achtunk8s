import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Action,
  agentReport,
  type HandleContext,
  type HandoverResult,
} from "@achtung/handover-sdk";
import type { Config } from "./config.ts";
import { type Herdr, HerdrError } from "./herdr.ts";
import { instructions } from "./instructions.ts";

/** How the investigation waits between looks at the agent; tests make it instant. */
export interface Pace {
  /** How long one `herdr agent wait` may take. */
  readonly waitMs: number;
  /** A pause after each look, so an agent that is settled already isn't asked in a loop. */
  readonly pauseMs: number;
  /** Looks at an agent that never began working before giving up on it. */
  readonly startLooks: number;
}

const defaultPace: Pace = { waitMs: 15_000, pauseMs: 2000, startLooks: 30 };

/** The findings file as a result: its first line the summary, the rest the body. */
function resultFrom(findings: string): HandoverResult | null {
  const lines = findings.trim().split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) {
    return null;
  }
  const summary = (lines[first] ?? "")
    .replace(/^[#>*\-\s]+/, "")
    .replaceAll(/[*_`]/g, "")
    .trim();
  return {
    outcome: "succeeded",
    summary: summary || "The agent finished",
    body: lines
      .slice(first + 1)
      .join("\n")
      .trim(),
    links: [],
  };
}

/** One investigation: its agent in herdr, and the files the two sides exchange. */
interface Investigation {
  readonly agent: string;
  readonly workspace: string;
  readonly resultPath: string;
}

/**
 * What a settled agent wrote; null when it wrote nothing but may not have begun yet. Once
 * it `hadItsChance`, nothing written is a failure.
 */
async function written(
  { workspace, resultPath }: Investigation,
  hadItsChance: boolean,
): Promise<HandoverResult | null> {
  const result = resultFrom(await readFile(resultPath, "utf8").catch(() => ""));
  if (result === null && hadItsChance) {
    throw new Error(
      `The agent stopped without writing its findings. Open herdr workspace ${workspace} to see why.`,
    );
  }
  return result;
}

/** When the work should stop: interrupts the agent, as Esc does, and throws why. */
async function stopIfAsked(herdr: Herdr, agent: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    await herdr.interrupt(agent).catch(() => {});
    throw signal.reason;
  }
}

/**
 * Follows the agent until it has written its findings. Says when the agent waits for a
 * person, which herdr shows; they answer it there, the reason an agent runs in herdr. Stops
 * the agent when the work should stop.
 */
async function findings(
  herdr: Herdr,
  investigation: Investigation,
  { progress, signal }: HandleContext,
  pace: Pace,
): Promise<HandoverResult> {
  const { agent, workspace } = investigation;
  let worked = false;
  let asking = false;
  for (let looks = 0; ; looks++) {
    await stopIfAsked(herdr, agent, signal);
    await herdr.wait(agent, pace.waitMs);
    const status = await herdr.status(agent);
    worked ||= status === "working";
    if (status === "blocked" && !asking) {
      await progress(`The agent is waiting for your input in herdr, workspace ${workspace}`);
    }
    asking = status === "blocked";
    if (status === "idle" || status === "done") {
      const result = await written(investigation, worked || looks >= pace.startLooks);
      if (result !== null) {
        return result;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pace.pauseMs));
  }
}

/** Starts the agent; when it asks something first, says so and waits for the answer. */
async function started(
  herdr: Herdr,
  config: Config,
  agent: string,
  pane: string,
  workspace: string,
  { progress, signal }: HandleContext,
  pace: Pace,
): Promise<void> {
  try {
    await herdr.startAgent(agent, config.agentKind, pane, config.agentArgs);
  } catch (error) {
    if (!(error instanceof HerdrError) || error.code !== "agent_not_ready") {
      throw error;
    }
    await progress(`The agent asks something before it starts: see herdr, workspace ${workspace}`);
    while ((await herdr.status(agent)) === "blocked") {
      signal.throwIfAborted();
      await herdr.wait(agent, pace.waitMs);
      await new Promise((resolve) => setTimeout(resolve, pace.pauseMs));
    }
  }
}

/**
 * The action this handler offers: an agent in a herdr workspace of its own investigates the
 * alert and writes its findings to a file, which the handler posts. The agent gets the
 * alert as a file and fixed instructions; it never holds the handover's claim token and has
 * no reason to reach the Achtung server.
 */
export function investigateAction(
  config: Config,
  herdr: Herdr,
  extraInstructions: string,
  pace: Pace = defaultPace,
): Action {
  return {
    id: "investigate",
    title: config.title,
    description:
      `Starts a ${config.agentKind} agent in herdr that looks into the alert, read-only, and ` +
      "reports what it found. You can open its workspace and steer it.",
    timeoutSeconds: config.timeoutSeconds,
    handle: async (handover, context) => {
      const folder = join("handovers", String(handover.id));
      const alertFile = join(folder, "alert.md");
      const resultFile = join(folder, "result.md");
      const resultPath = join(config.workDir, resultFile);
      await mkdir(join(config.workDir, folder), { recursive: true });
      await writeFile(join(config.workDir, alertFile), agentReport(handover));
      // A file left by an earlier run of this id, e.g. on a fake server, isn't the answer.
      await rm(resultPath, { force: true });

      const agent = `inv-${handover.id}`;
      const label = `achtung-${handover.id}`;
      const { workspace, pane } = await herdr.createWorkspace(config.workDir, label);
      try {
        await started(herdr, config, agent, pane, label, context, pace);
        await herdr.prompt(agent, instructions(alertFile, resultFile, extraInstructions));
        await context.progress(`Agent ${agent} started in herdr, workspace ${label}`);
        return await findings(herdr, { agent, workspace: label, resultPath }, context, pace);
      } finally {
        if (!config.keepWorkspace) {
          await herdr.closeWorkspace(workspace).catch(() => {});
        }
      }
    },
  };
}
