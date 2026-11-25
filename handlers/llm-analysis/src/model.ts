import type { ModelConfig } from "./config.ts";

// One question to an OpenAI-compatible chat API. What goes wrong here is said in fixed
// words: an error from the API or from fetch can repeat the request, and so the alert or
// the key, and the handover's error is shown to everyone.

/** The text of a message's content: a string, or the text parts of a list. */
function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part?.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** Without the reasoning some local models put first, between think tags. */
const withoutThinking = (text: string) => text.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();

/** The model's answer to `system` and `user`. */
export async function ask(
  config: ModelConfig,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    // The handover was stopped: that reason, not fetch's.
    signal.throwIfAborted();
    throw new Error(
      timeout.aborted
        ? `The model didn't answer within ${config.timeoutSeconds} seconds`
        : "The model's API couldn't be reached",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The model's API answered ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown } }[];
  } | null;
  const answer = withoutThinking(textOf(body?.choices?.[0]?.message?.content));
  if (answer === "") {
    throw new Error("The model's API answered without any text");
  }
  return answer;
}
