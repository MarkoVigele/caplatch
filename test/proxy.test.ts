import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER } from "../src/constants";
import { proxyChat } from "../src/gate";
import { estimateCallCents, lookupModel, quoteUsage } from "../src/prices";
import { OPENROUTER_CHAT_COMPLETIONS_URL, chatMode } from "../src/upstream";
import { CLIENT_SUPPLIED_KEY, FIXTURE_OPENROUTER_KEY } from "./fixture";
import { audit, clearLedger, ledgerStub, postJson, withUpstreamSpy, type UpstreamCall } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

const MESSAGES = [{ role: "user", content: "hi" }];

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openai/gpt-4o-mini",
    messages: MESSAGES,
    max_tokens: 1,
    ...extra,
  };
}

function upstreamJson(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function postChat(
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    respond?: (call: UpstreamCall) => Response | Promise<Response>;
  },
): Promise<{
  response: Response;
  text: string;
  upstreamCalls: number;
  calls: UpstreamCall[];
}> {
  const guarded = await withUpstreamSpy(async () => {
    const response = await postJson("/v1/chat/completions", body, options?.headers);
    const text = await response.text();
    return { response, text };
  }, options?.respond);
  return {
    response: guarded.result.response,
    text: guarded.result.text,
    upstreamCalls: guarded.upstreamCalls,
    calls: guarded.calls,
  };
}

async function readRows(): Promise<
  { id: string; amount: number; status: string; settled: number | null }[]
> {
  return runInDurableObject(ledgerStub(), async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ id: string; amount_cents: number; status: string; settled_cents: number | null }>(
        `SELECT id, amount_cents, status, settled_cents FROM reservations`,
      )
      .toArray();
    return rows.map((row) => ({
      id: String(row.id),
      amount: Number(row.amount_cents),
      status: String(row.status),
      settled: row.settled_cents === null ? null : Number(row.settled_cents),
    }));
  });
}

function pricedMini() {
  const looked = lookupModel("openai/gpt-4o-mini");
  if (!looked.ok) {
    throw new Error("gpt-4o-mini must stay priced");
  }
  return looked.price;
}

describe("openrouter proxy", () => {
  it("refuses a full cap with no fetch and no new reservation", async () => {
    const filled = await ledgerStub().reserve(10, "fill-the-cap");
    expect(filled.ok).toBe(true);
    const before = await ledgerStub().status();
    const beforeAudit = await audit(before.periodKey);
    const outcome = await postChat(
      chatBody({
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        api_key: CLIENT_SUPPLIED_KEY,
      }),
      { headers: { authorization: `Bearer ${CLIENT_SUPPLIED_KEY}` } },
    );
    const after = await ledgerStub().status();
    const afterAudit = await audit(after.periodKey);
    let body: { ok?: boolean; error?: string } = {};
    try {
      body = JSON.parse(outcome.text) as { ok?: boolean; error?: string };
    } catch {
      body = {};
    }
    if (
      outcome.upstreamCalls !== 0 ||
      outcome.response.ok ||
      body.ok === true ||
      after.committedCents > after.capCents ||
      after.committedCents !== before.committedCents ||
      afterAudit.rows !== beforeAudit.rows ||
      afterAudit.committed !== beforeAudit.committed
    ) {
      throw new Error(
        `cap-full chat was not refused cleanly: status=${outcome.response.status} ok=${String(body.ok)} error=${String(body.error)} upstreamCalls=${outcome.upstreamCalls} committed=${after.committedCents} cap=${after.capCents} rows=${afterAudit.rows}`,
      );
    }
    expect(outcome.response.status).toBe(402);
    expect(body.error).toBe("cap_exceeded");
    expect(after.committedCents).toBe(after.capCents);
    expect(afterAudit).toMatchObject({ committed: 10, held: 10, rows: 1 });
  });

  it("fetches OpenRouter once under the cap and bills the response, not the client", async () => {
    if (env.OPENROUTER_API_KEY !== FIXTURE_OPENROUTER_KEY) {
      throw new Error("OPENROUTER_API_KEY binding is not the test fixture");
    }
    if (env.UPSTREAM_ENABLED !== "true") {
      throw new Error("UPSTREAM_ENABLED must be true for the proxy proof");
    }
    const responseUsage = { prompt_tokens: 0, completion_tokens: 1 };
    const clientUsage = { prompt_tokens: 0, completion_tokens: 5_000_000 };
    const price = pricedMini();
    const quoted = quoteUsage(price, responseUsage);
    const ignored = quoteUsage(price, clientUsage);
    const hold = estimateCallCents(price, MESSAGES, 1);
    if (
      quoted === "missing_usage" ||
      ignored === "missing_usage" ||
      quoted <= 0 ||
      quoted >= hold ||
      ignored <= hold
    ) {
      throw new Error(
        `fixture usage does not separate the bills: quoted=${String(quoted)} ignored=${String(ignored)} hold=${hold}`,
      );
    }
    const payload = {
      id: "gen_m1c",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: responseUsage,
    };
    const outcome = await postChat(
      chatBody({
        usage: clientUsage,
        api_key: CLIENT_SUPPLIED_KEY,
        apiKey: CLIENT_SUPPLIED_KEY,
      }),
      {
        headers: { authorization: `Bearer ${CLIENT_SUPPLIED_KEY}` },
        respond: () => upstreamJson(201, payload),
      },
    );
    const call = outcome.calls[0];
    const forwarded = call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : null;
    const authorization = call?.authorization ?? null;
    if (
      outcome.upstreamCalls !== 1 ||
      authorization !== `Bearer ${FIXTURE_OPENROUTER_KEY}` ||
      authorization.includes(CLIENT_SUPPLIED_KEY) ||
      call?.body?.includes(CLIENT_SUPPLIED_KEY) ||
      call?.body?.includes(FIXTURE_OPENROUTER_KEY) ||
      forwarded?.usage !== undefined ||
      call?.url !== OPENROUTER_CHAT_COMPLETIONS_URL ||
      call?.method !== "POST"
    ) {
      throw new Error(
        `under-cap proxy proof failed: upstreamCalls=${outcome.upstreamCalls} authorizationIsFixture=${String(authorization === `Bearer ${FIXTURE_OPENROUTER_KEY}`)} clientKeyLeaked=${String(authorization?.includes(CLIENT_SUPPLIED_KEY) || call?.body?.includes(CLIENT_SUPPLIED_KEY))} url=${String(call?.url)}`,
      );
    }
    expect(outcome.response.status).toBe(201);
    expect(outcome.text).toBe(JSON.stringify(payload));
    expect(outcome.text).not.toContain("reservationId");
    expect(outcome.text).not.toContain("committedCents");
    const status = await ledgerStub().status();
    const rows = await readRows();
    if (rows.length !== 1 || rows[0]?.status !== "settled" || rows[0].settled !== quoted || status.committedCents !== quoted) {
      throw new Error(
        `response usage was not the bill: committed=${status.committedCents} quoted=${quoted} rows=${JSON.stringify(rows)}`,
      );
    }
    expect(status.committedCents).toBeLessThanOrEqual(status.capCents);
    expect(rows[0].amount).toBeGreaterThan(quoted);
  });

  it("does not fetch an unknown model or a missing price", async () => {
    const unknown = await postChat(
      chatBody({
        model: "no-such-model",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        api_key: CLIENT_SUPPLIED_KEY,
      }),
      { headers: { authorization: `Bearer ${CLIENT_SUPPLIED_KEY}` } },
    );
    const unpriced = await postChat(
      chatBody({
        model: "fixture/unpriced",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const status = await ledgerStub().status();
    const stored = await audit(status.periodKey);
    if (unknown.upstreamCalls !== 0 || unpriced.upstreamCalls !== 0 || stored.rows !== 0 || status.committedCents !== 0) {
      throw new Error(
        `unpriced chat reached upstream or the ledger: unknownCalls=${unknown.upstreamCalls} unpricedCalls=${unpriced.upstreamCalls} rows=${stored.rows} committed=${status.committedCents}`,
      );
    }
    expect(unknown.response.status).toBe(402);
    expect(JSON.parse(unknown.text)).toMatchObject({ ok: false, error: "unknown_model" });
    expect(unpriced.response.status).toBe(402);
    expect(JSON.parse(unpriced.text)).toMatchObject({ ok: false, error: "missing_price" });
  });

  it("charges the full hold when the OpenRouter body has no usage", async () => {
    const payload = { id: "gen_no_usage", choices: [{ message: { content: "ok" } }] };
    const outcome = await postChat(chatBody({ usage: { prompt_tokens: 0, completion_tokens: 0 } }), {
      respond: () => upstreamJson(200, payload),
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      outcome.upstreamCalls !== 1 ||
      outcome.text !== JSON.stringify(payload) ||
      rows.length !== 1 ||
      !row ||
      row.status !== "settled" ||
      row.settled === null ||
      row.settled === 0 ||
      row.settled !== row.amount ||
      status.committedCents !== row.amount ||
      status.committedCents === 0
    ) {
      throw new Error(
        `missing response usage was not charged at the hold: upstreamCalls=${outcome.upstreamCalls} status=${row?.status} settled=${String(row?.settled)} amount=${String(row?.amount)} committed=${status.committedCents}`,
      );
    }
    expect(row.status).not.toBe("released");
    expect(status.committedCents).toBeLessThanOrEqual(status.capCents);
    const released = await ledgerStub().release(row.id);
    expect(released).toMatchObject({ ok: false, error: "not_held" });
    expect((await ledgerStub().status()).committedCents).toBe(row.amount);
  });

  it("settles explicit zero usage as zero cents", async () => {
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const quoted = quoteUsage(pricedMini(), usage);
    if (quoted !== 0) {
      throw new Error("zero token usage must quote to 0 cents");
    }
    const payload = { id: "gen_zero", usage };
    const outcome = await postChat(chatBody(), {
      respond: () => upstreamJson(200, payload),
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      outcome.upstreamCalls !== 1 ||
      !row ||
      row.status !== "settled" ||
      row.settled !== 0 ||
      status.committedCents !== 0
    ) {
      throw new Error(
        `explicit zero usage was not settled to 0: upstreamCalls=${outcome.upstreamCalls} settled=${String(row?.settled)} committed=${status.committedCents}`,
      );
    }
    expect(row.amount).toBeGreaterThan(0);
    expect(outcome.text).toBe(JSON.stringify(payload));
  });

  it("keeps the hold when response usage exceeds it and does not fetch again", async () => {
    const price = pricedMini();
    const usage = { prompt_tokens: 0, completion_tokens: 5_000_000 };
    const quoted = quoteUsage(price, usage);
    const hold = estimateCallCents(price, MESSAGES, 1);
    if (quoted === "missing_usage" || quoted <= hold) {
      throw new Error("fixture usage must exceed the pessimistic hold");
    }
    const payload = { id: "gen_over", usage };
    let fetches = 0;
    const outcome = await postChat(chatBody({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      respond: () => {
        fetches += 1;
        return upstreamJson(200, payload);
      },
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      outcome.upstreamCalls !== 1 ||
      fetches !== 1 ||
      outcome.text !== JSON.stringify(payload) ||
      outcome.text.includes("exceeds_hold") ||
      !row ||
      row.status !== "held" ||
      row.settled !== null ||
      row.amount !== hold ||
      status.committedCents !== hold ||
      status.committedCents > status.capCents
    ) {
      throw new Error(
        `usage above the hold was not left in place: upstreamCalls=${outcome.upstreamCalls} fetches=${fetches} rowStatus=${String(row?.status)} settled=${String(row?.settled)} committed=${status.committedCents} cap=${status.capCents}`,
      );
    }
    const again = await ledgerStub().settle(row.id, quoted);
    const after = await ledgerStub().status();
    if (again.ok || again.error !== "exceeds_hold" || after.committedCents !== hold) {
      throw new Error(
        `hold did not stay exceeds_hold: ok=${String(again.ok)} error=${String(again.ok ? "" : again.error)} committed=${after.committedCents}`,
      );
    }
    expect(after.committedCents).toBeLessThanOrEqual(after.capCents);
  });

  it("does not fetch again when the same request id is retried", async () => {
    const payload = { id: "gen_once", usage: { prompt_tokens: 8, completion_tokens: 4 } };
    const headers = { [REQUEST_ID_HEADER]: "one-attempt" };
    const first = await postChat(chatBody(), {
      headers,
      respond: () => upstreamJson(200, payload),
    });
    const second = await postChat(chatBody(), {
      headers,
      respond: () => upstreamJson(200, { id: "gen_twice" }),
    });
    const rows = await readRows();
    if (first.upstreamCalls !== 1 || second.upstreamCalls !== 0 || rows.length !== 1) {
      throw new Error(
        `retry fetched again or reserved again: first=${first.upstreamCalls} second=${second.upstreamCalls} rows=${rows.length}`,
      );
    }
    expect(second.response.status).toBe(409);
    expect(JSON.parse(second.text)).toEqual({ ok: false, error: "idempotency_replay" });
    expect(first.text).toBe(JSON.stringify(payload));
  });

  it("charges the hold once when the upstream fetch throws", async () => {
    const outcome = await postChat(chatBody(), {
      respond: () => {
        throw new Error("socket closed");
      },
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      outcome.upstreamCalls !== 1 ||
      outcome.response.status !== 502 ||
      !row ||
      row.status !== "settled" ||
      row.settled !== row.amount ||
      row.settled === 0 ||
      status.committedCents !== row.amount
    ) {
      throw new Error(
        `thrown fetch was not charged once: upstreamCalls=${outcome.upstreamCalls} http=${outcome.response.status} settled=${String(row?.settled)} amount=${String(row?.amount)} committed=${status.committedCents}`,
      );
    }
    expect(JSON.parse(outcome.text)).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(outcome.text).not.toContain(FIXTURE_OPENROUTER_KEY);
  });

  it("does not reserve or fetch when upstream is off or the key is missing", async () => {
    const body = chatBody();
    const ledger = {
      reserve(): never {
        throw new Error("reserved while upstream is off");
      },
      settle(): never {
        throw new Error("settled while upstream is off");
      },
    };
    const disabled = await proxyChat(
      ledger,
      chatBody({ stream: true }),
      null,
      chatMode({ UPSTREAM_ENABLED: "false", OPENROUTER_API_KEY: FIXTURE_OPENROUTER_KEY }),
      undefined,
    );
    const missing = await proxyChat(
      ledger,
      body,
      null,
      chatMode({ UPSTREAM_ENABLED: "true", OPENROUTER_API_KEY: "  " }),
      undefined,
    );
    const blank = await proxyChat(ledger, body, null, chatMode({ UPSTREAM_ENABLED: "true" }), "usd");
    if (disabled.kind !== "refuse" || missing.kind !== "refuse" || blank.kind !== "refuse") {
      throw new Error("upstream that is off still tried to forward");
    }
    expect(disabled).toMatchObject({ status: 503, body: { ok: false, error: "upstream_disabled" } });
    expect(missing).toMatchObject({ status: 503, body: { ok: false, error: "upstream_unconfigured" } });
    expect(blank).toMatchObject({ status: 503, body: { ok: false, error: "upstream_unconfigured" } });
  });
});
