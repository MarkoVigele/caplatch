import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { lookupModel, pricedModelIds, unpricedModelIds } from "../src/prices";
import { audit, clearLedger, ledgerStub, postJson } from "./helpers";

const NAMED = ["openai/gpt-4o-mini", "openai/gpt-4o"] as const;

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

describe("price table", () => {
  it("prices exactly the two README models and does not fetch", () => {
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      fetched.push(url);
      throw new Error(`request path fetched a price: ${url}`);
    }) as typeof fetch;
    try {
      const ids = pricedModelIds();
      if (ids.length !== NAMED.length || NAMED.some((id) => !ids.includes(id))) {
        throw new Error(`price table must be exactly the two README models, found: ${ids.join(", ") || "(none)"}`);
      }
      const mini = lookupModel("openai/gpt-4o-mini");
      const full = lookupModel("openai/gpt-4o");
      if (!mini.ok) {
        throw new Error("named model has no price: openai/gpt-4o-mini");
      }
      if (!full.ok) {
        throw new Error("named model has no price: openai/gpt-4o");
      }
      if (mini.price.promptCentsPerMillion !== 15 || mini.price.completionCentsPerMillion !== 60) {
        throw new Error(
          `named model has no price: openai/gpt-4o-mini rates ${mini.price.promptCentsPerMillion}/${mini.price.completionCentsPerMillion}`,
        );
      }
      if (full.price.promptCentsPerMillion !== 250 || full.price.completionCentsPerMillion !== 1000) {
        throw new Error(
          `named model has no price: openai/gpt-4o rates ${full.price.promptCentsPerMillion}/${full.price.completionCentsPerMillion}`,
        );
      }
      const unpricedIds = unpricedModelIds();
      if (unpricedIds.length !== 1 || unpricedIds[0] !== "fixture/unpriced") {
        throw new Error(`fixture/unpriced must stay the only missing price, found: ${unpricedIds.join(", ")}`);
      }
      const unpriced = lookupModel("fixture/unpriced");
      if (unpriced.ok || unpriced.error !== "missing_price") {
        throw new Error("fixture/unpriced must stay missing_price");
      }
      if (fetched.length !== 0) {
        throw new Error(`request path fetched a price: ${fetched.join(", ")}`);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not let an unknown model through", async () => {
    const stranger = lookupModel("openai/gpt-4.1");
    if (stranger.ok || stranger.error !== "unknown_model") {
      throw new Error("unknown model got through: openai/gpt-4.1");
    }
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      fetched.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    try {
      const response = await postJson("/v1/chat/completions", {
        model: "openai/gpt-4.1",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      const status = await ledgerStub().status();
      const stored = await audit(status.periodKey);
      if (
        response.ok ||
        body.ok === true ||
        body.error !== "unknown_model" ||
        fetched.length !== 0 ||
        stored.rows !== 0 ||
        status.committedCents !== 0
      ) {
        throw new Error(
          `unknown model got through: status=${response.status} error=${String(body.error)} fetches=${fetched.length} rows=${stored.rows} committed=${status.committedCents}`,
        );
      }
      expect(response.status).toBe(402);
      expect(env.CURRENCY).toBeUndefined();
      expect(status.capCents).toBe(10);
    } finally {
      globalThis.fetch = original;
    }
  });
});
