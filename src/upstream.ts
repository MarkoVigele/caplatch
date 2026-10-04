export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export type UpstreamCaller = (payload: string) => Promise<Response>;

export type UpstreamMode =
  | { kind: "off"; error: "upstream_disabled" | "upstream_unconfigured" }
  | { kind: "on"; call: UpstreamCaller };

type UpstreamEnv = {
  UPSTREAM_ENABLED?: string;
  OPENROUTER_API_KEY?: string;
};

/**
 * Production stays off until the installer sets UPSTREAM_ENABLED to "true"
 * and stores the upstream key as the OPENROUTER_API_KEY secret.
 * The key is read only from that binding. It is not taken from the request.
 */
export function chatMode(env: UpstreamEnv): UpstreamMode {
  if (env.UPSTREAM_ENABLED !== "true") {
    return { kind: "off", error: "upstream_disabled" };
  }
  const key = env.OPENROUTER_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) {
    return { kind: "off", error: "upstream_unconfigured" };
  }
  const apiKey = key.trim();
  return {
    kind: "on",
    call: (payload) => forwardUpstream(payload, apiKey),
  };
}

/** One POST. The Authorization value is the env key, never a client header. */
export function forwardUpstream(
  body: string,
  apiKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${apiKey}`);
  return fetcher(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
}
