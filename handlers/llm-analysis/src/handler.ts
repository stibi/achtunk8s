import type { Action } from "@achtung/handover-sdk";
import type { Config } from "./config.ts";
import { ask } from "./model.ts";
import { alertMessage, newMarker, systemPrompt } from "./prompt.ts";

/** The first line of the answer as plain text: the summary. */
export function summaryOf(answer: string): string {
  const first = answer.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    first
      // A list or heading marker, not a number the sentence starts with.
      .replace(/^\s*(?:\d+[.)]\s+)?[#>*\-\s]*/, "")
      .replaceAll(/[*_`]/g, "")
      .trim() || "The model answered"
  );
}

/** The action this handler offers: one question to the model per handover. */
export function explainAction(config: Config): Action {
  // Short enough for the button's help text, whatever the API calls its model.
  const name = config.model.model;
  const model = name.length > 60 ? `${name.slice(0, 59)}…` : name;
  const redaction = { labels: config.dropLabels, annotations: config.dropAnnotations };
  return {
    id: "explain",
    title: config.title,
    description:
      `Asks the model ${model} what the alert means and where to look. ` +
      "It reads the alert only; it investigates nothing.",
    timeoutSeconds: Math.max(60, config.model.timeoutSeconds + 30),
    handle: async (handover, { progress, signal }) => {
      await progress(`asking ${model}`);
      const marker = newMarker();
      const answer = await ask(
        config.model,
        systemPrompt(marker),
        alertMessage(handover, redaction, marker),
        signal,
      );
      return {
        outcome: "succeeded",
        summary: summaryOf(answer),
        body: `${answer}\n\n_From ${model}, which read the alert and nothing else._`,
        links: [],
      };
    },
  };
}
