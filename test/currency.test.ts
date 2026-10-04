import { describe, expect, it } from "vitest";
import { capInUsCents, readCurrency, US_CENTS_PER_EURO } from "../src/currency";
import { proxyChat } from "../src/gate";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("currency latch", () => {
  it("keeps a usd cap unchanged and converts 100 euro-cents without a fetch", () => {
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      fetched.push(url);
      throw new Error(`EUR conversion performed a fetch: ${url}`);
    }) as typeof fetch;
    try {
      if (US_CENTS_PER_EURO !== 110) {
        throw new Error(`euro rate is ${US_CENTS_PER_EURO}, not 110 US cents per euro`);
      }
      const missing = readCurrency(undefined);
      const blank = readCurrency("  ");
      const usd = readCurrency("usd");
      const usdUpper = readCurrency("USD");
      const eur = readCurrency("eur");
      const eurUpper = readCurrency("EUR");
      const other = readCurrency("gbp");
      if (!missing.ok || missing.currency !== "usd" || !blank.ok || !usd.ok || !usdUpper.ok || usd.currency !== "usd") {
        throw new Error("missing or usd did not leave the currency as usd");
      }
      if (!eur.ok || eur.currency !== "eur" || !eurUpper.ok || eurUpper.currency !== "eur") {
        throw new Error("eur was not accepted");
      }
      if (other.ok) {
        throw new Error("unsupported currency got through");
      }
      const usdCap = capInUsCents(100, "usd");
      const eurCap = capInUsCents(100, "eur");
      if (usdCap !== 100) {
        throw new Error(`usd cap changed from 100 to ${usdCap}`);
      }
      if (eurCap !== 110) {
        throw new Error(`100 euro-cents became ${eurCap} US cents`);
      }
      if (fetched.length !== 0) {
        throw new Error(`EUR conversion performed a fetch: ${fetched.join(", ")}`);
      }
      expect(other).toEqual({ ok: false, error: "unsupported_currency" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses an unsupported currency before reserve or fetch", async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (() => {
      fetches += 1;
      throw new Error("unsupported currency fetched");
    }) as typeof fetch;
    try {
      const decision = await proxyChat(
        {
          reserve() {
            throw new Error("unsupported currency reserved");
          },
          settle() {
            throw new Error("unsupported currency settled");
          },
        },
        {
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        },
        null,
        {
          kind: "on",
          call: () => {
            throw new Error("unsupported currency fetched");
          },
        },
        "gbp",
      );
      if (decision.kind !== "refuse" || fetches !== 0) {
        throw new Error(
          `unsupported currency was not refused before reserve or fetch: kind=${decision.kind} fetches=${fetches}`,
        );
      }
      expect(decision).toMatchObject({
        status: 400,
        body: { ok: false, error: "unsupported_currency" },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
