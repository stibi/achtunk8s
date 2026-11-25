import type { ClaimedHandover, HandoverResult, HandoverState, Registration } from "./protocol.ts";

export interface ClientOptions {
  /** The Achtung server, e.g. `http://achtung.example`. */
  readonly server: string;
  /** This handler's id: lowercase letters, digits and dashes. */
  readonly id: string;
  /** The handler's token, when the server requires one (HANDLER_TOKENS). */
  readonly token?: string | undefined;
  /** `fetch` itself, unless a test supplies its own. */
  readonly fetch?: typeof fetch | undefined;
}

/** The server answered in a way the protocol doesn't expect here, e.g. 401 or 500. */
export class HandlerApiError extends Error {
  readonly status: number;

  constructor(call: string, status: number, reason: string) {
    super(`${call}: ${status} ${reason}`.trim());
    this.name = "HandlerApiError";
    this.status = status;
  }
}

export type Claim =
  | { readonly kind: "claimed"; readonly handover: ClaimedHandover }
  /** Nothing waits; ask again. */
  | { readonly kind: "none" }
  /** The server doesn't know this handler: register, then claim again. */
  | { readonly kind: "unregistered" }
  /** Too many claims are waiting: pause, then ask again. */
  | { readonly kind: "busy" };

export type Answered =
  | { readonly kind: "ended" }
  /** The handover ended another way first: cancelled, timed out, handler lost. */
  | { readonly kind: "too-late" }
  /** The server refused the result as invalid, with its reason. */
  | { readonly kind: "refused"; readonly reason: string };

/** The handler API of one server, for one handler: each call of the protocol, once. */
export interface HandlerClient {
  register(registration: Registration): Promise<void>;
  /** Asks for the next handover, waiting up to `waitSeconds` for one. */
  claim(waitSeconds: number, signal?: AbortSignal): Promise<Claim>;
  /** Renews the lease, with a status line if there is one. Says where the handover is. */
  progress(handover: ClaimedHandover, message?: string): Promise<HandoverState>;
  answer(handover: ClaimedHandover, result: HandoverResult): Promise<Answered>;
}

export function handlerClient(options: ClientOptions): HandlerClient {
  const api = `${options.server.replace(/\/+$/, "")}/api/handler/v0`;
  const send = options.fetch ?? fetch;
  const authorization =
    options.token === undefined ? {} : { authorization: `Bearer ${options.token}` };

  const call = (
    method: "PUT" | "POST",
    path: string,
    init: { body?: unknown; claim?: string; signal?: AbortSignal | undefined } = {},
  ) =>
    send(`${api}/${path}`, {
      method,
      headers: {
        ...authorization,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.claim === undefined ? {} : { "achtung-claim": init.claim }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });

  const handlerPath = `handlers/${encodeURIComponent(options.id)}`;
  return {
    register: async (registration) => {
      const response = await call("PUT", handlerPath, { body: registration });
      if (!response.ok) {
        throw await failure("register", response);
      }
    },
    claim: async (waitSeconds, signal) => {
      const response = await call("POST", `${handlerPath}/claim?wait=${waitSeconds}`, { signal });
      switch (response.status) {
        case 200:
          return { kind: "claimed", handover: (await response.json()) as ClaimedHandover };
        case 204:
          return { kind: "none" };
        case 404:
          return { kind: "unregistered" };
        case 503:
          return { kind: "busy" };
        default:
          throw await failure("claim", response);
      }
    },
    progress: async (handover, message) => {
      const response = await call("POST", `handovers/${handover.id}/progress`, {
        body: message === undefined ? {} : { message },
        claim: handover.claimToken,
      });
      if (!response.ok) {
        throw await failure("progress", response);
      }
      return ((await response.json()) as { state: HandoverState }).state;
    },
    answer: async (handover, result) => {
      const response = await call("POST", `handovers/${handover.id}/result`, {
        body: result,
        claim: handover.claimToken,
      });
      if (response.ok) {
        return { kind: "ended" };
      }
      if (response.status === 409) {
        return { kind: "too-late" };
      }
      if (response.status === 400) {
        return { kind: "refused", reason: await reasonOf(response) };
      }
      throw await failure("result", response);
    },
  };
}

async function reasonOf(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : text;
  } catch {
    return text;
  }
}

async function failure(call: string, response: Response): Promise<HandlerApiError> {
  return new HandlerApiError(call, response.status, await reasonOf(response));
}
