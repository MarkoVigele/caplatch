import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { capInUsCents } from "../src/currency";
import { estimateCallCents, lookupModel } from "../src/prices";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../src/upstream";
import { audit, clearLedger, ledgerStub, postJson } from "./helpers";

const MESSAGES = [{ role: "user", content: "hi" }];

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

async function readRows(): Promise<{ id: string; amount: number; status: string }[]> {
  return runInDurableObject(ledgerStub(), async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ id: string; amount_cents: number; status: string }>(
        `SELECT id, amount_cents, status FROM reservations`,
      )
      .toArray();
    return rows.map((row) => ({
      id: String(row.id),
      amount: Number(row.amount_cents),
      status: String(row.status),
    }));
  });
}

describe("euro cap", () => {
  it("turns 100 euro-cents into a 110 US-cent cap without a fetch", async () => {
    if (env.CURRENCY !== "eur" || env.CAP_CENTS !== "100") {
      throw new Error(`euro proof env is CURRENCY=${String(env.CURRENCY)} CAP_CENTS=${String(env.CAP_CENTS)}`);
    }
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      fetched.push(url);
      return Promise.resolve(new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
    try {
      const converted = capInUsCents(100, "eur");
      const status = await ledgerStub().status();
      const held = await ledgerStub().reserve(110, "euro-exact");
      const over = await ledgerStub().reserve(1, "euro-over");
      if (fetched.length !== 0) {
        throw new Error(`EUR conversion performed a fetch: ${fetched.join(",")}`);
      }
      if (converted !== 110 || status.capCents !== 110 || !held.ok || held.capCents !== 110) {
        throw new Error(
          `100 euro-cents became cap=${status.capCents} converted=${converted} held=${String(held.ok)}`,
        );
      }
      if (over.ok || over.error !== "cap_exceeded") {
        throw new Error(
          `euro cap allowed more than 110 US cents: overOk=${String(over.ok)} error=${String(over.ok ? "" : over.error)}`,
        );
      }
      expect(status.committedCents).toBe(0);
      expect(held.committedCents).toBe(110);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("bills the euro chat in US cents and does not fetch a rate", async () => {
    const mini = lookupModel("openai/gpt-4o-mini");
    const full = lookupModel("openai/gpt-4o");
    if (!mini.ok) {
      throw new Error("named model has no price: openai/gpt-4o-mini");
    }
    if (!full.ok) {
      throw new Error("named model has no price: openai/gpt-4o");
    }
    const hold = estimateCallCents(full.price, MESSAGES, 1);
    const original = globalThis.fetch;
    const foreign: string[] = [];
    let chatFetches = 0;
    let reservedBeforeFetch = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url !== OPENROUTER_CHAT_COMPLETIONS_URL) {
        foreign.push(url);
        return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
      }
      chatFetches += 1;
      const status = await ledgerStub().status();
      reservedBeforeFetch = status.committedCents === hold;
      return new Response(
        JSON.stringify({
          id: "gen_eur",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 0, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const response = await postJson("/v1/chat/completions", {
        model: "openai/gpt-4o",
        messages: MESSAGES,
        max_tokens: 1,
      });
      const text = await response.text();
      const rows = await readRows();
      const status = await ledgerStub().status();
      if (foreign.length !== 0) {
        throw new Error(`EUR conversion performed a fetch: ${foreign.join(",")}`);
      }
      if (chatFetches !== 1 || !reservedBeforeFetch) {
        throw new Error(
          `euro chat did not reserve in US cents before the one upstream fetch: chatFetches=${chatFetches} reservedBeforeFetch=${String(reservedBeforeFetch)}`,
        );
      }
      const row = rows[0];
      if (!response.ok || rows.length !== 1 || !row || row.amount !== hold || status.capCents !== 110) {
        throw new Error(
          `euro chat was not billed in US cents against a 110 cap: status=${response.status} body=${text.slice(0, 120)} amount=${String(row?.amount)} hold=${hold} cap=${status.capCents}`,
        );
      }
      expect(hold).toBeGreaterThan(0);
      expect(status.committedCents).toBeLessThanOrEqual(110);
      expect(await audit(status.periodKey)).toMatchObject({ rows: 1 });
    } finally {
      globalThis.fetch = original;
    }
  });
});
