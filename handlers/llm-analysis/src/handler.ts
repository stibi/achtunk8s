import type { Action } from "@achtung/handover-sdk";
import type { Config } from "./config.ts";
import { ask } from "./model.ts";
import { alertMessage, systemPrompt } from "./prompt.ts";

/** The first line of the answer as plain text: the summary. */
function summaryOf(answer: string): string {
  const first = answer.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    first
      .replace(/^[#>*\-\s\d.]+/, "")
      .replaceAll(/[*_`]/g, "")
      .trim() || "The model answered"
  );
}

/** The action this handler offers: one question to the model per handover. */
export function explainAction(config: Config): Action {
  return {
    id: "explain",
    title: config.title,
    description:
      `Asks the model ${config.model.model} what the alert means and where to look. ` +
      "It reads the alert only; it investigates nothing.",
    timeoutSeconds: Math.max(60, config.model.timeoutSeconds + 30),
    handle: async (handover, { progress, signal }) => {
      await progress(`asking ${config.model.model}`);
      const answer = await ask(
        config.model,
        systemPrompt,
        alertMessage(handover, config.dropLabels, config.dropAnnotations),
        signal,
      );
      return {
        outcome: "succeeded",
        summary: summaryOf(answer),
        body: `${answer}\n\n_From ${config.model.model}, which read the alert and nothing else._`,
        links: [],
      };
    },
  };
}
