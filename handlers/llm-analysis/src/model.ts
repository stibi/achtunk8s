import type { ModelConfig } from "./config.ts";

/** The model's answer to `system` and `user`, from an OpenAI-compatible chat API. */
export async function ask(
  config: ModelConfig,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]),
  });
  if (!response.ok) {
    // The status only: an error body may echo the request, and so the alert.
    throw new Error(`The model's API answered ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The model's API answered without any text");
  }
  return content.trim();
}
