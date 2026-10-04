import { beforeEach, describe, expect, it } from "vitest";
import { windowFor } from "../src/period";
import { audit, clearLedger, postJson } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("unsupported currency", () => {
  it("refuses the chat before reserve or fetch", async () => {
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      fetched.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "should-not-run" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    try {
      const response = await postJson("/v1/chat/completions", {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      const periodKey = windowFor(Date.now(), "month").periodKey;
      const stored = await audit(periodKey);
      if (
        response.ok ||
        body.ok === true ||
        body.error !== "unsupported_currency" ||
        fetched.length !== 0 ||
        stored.rows !== 0 ||
        stored.committed !== 0
      ) {
        throw new Error(
          `unsupported currency was not refused before reserve or fetch: status=${response.status} error=${String(body.error)} fetches=${fetched.join(",")} rows=${stored.rows} committed=${stored.committed}`,
        );
      }
      expect(response.status).toBe(400);
    } finally {
      globalThis.fetch = original;
    }
  });
});
