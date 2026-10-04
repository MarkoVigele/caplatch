import { UPSTREAM_ENABLED } from "./constants";

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export function forwardUpstream(body: string, fetcher: typeof fetch = globalThis.fetch): Promise<Response> {
  return fetcher(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Called only after the fail-closed gates accept a call. M1b leaves the proxy off. */
export async function forwardIfEnabled(body: string): Promise<void> {
  if (!UPSTREAM_ENABLED) {
    return;
  }
  await forwardUpstream(body);
}
