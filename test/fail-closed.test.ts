import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA } from "../src/ledger";
import { lookupModel, quoteUsage } from "../src/prices";
import { forwardUpstream } from "../src/upstream";
import { FIXTURE_OPENROUTER_KEY } from "./fixture";
import { audit, clearLedger, ledgerStub, postJson, withUpstreamSpy } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

type LatchBody = {
  ok?: boolean;
  error?: string;
  reservationId?: string;
  amountCents?: number;
};

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    ...extra,
  };
}

function proveRefused(response: Response, body: LatchBody, upstreamCalls: number): void {
  if (response.ok || body.ok === true || upstreamCalls !== 0) {
    throw new Error(
      `fail-closed proof failed: status=${response.status} ok=${String(body.ok)} error=${String(body.error)} upstreamCalls=${upstreamCalls}`,
    );
  }
  expect(response.ok).toBe(false);
  expect(body.ok).toBe(false);
  expect(upstreamCalls).toBe(0);
}

function proveHoldCapped(settledOk: boolean, before: number, after: number, cap: number): void {
  if (settledOk || after > cap || after > before) {
    throw new Error(
      `settle above the hold lifted commitment: settledOk=${String(settledOk)} before=${before} after=${after} cap=${cap}`,
    );
  }
  expect(settledOk).toBe(false);
  expect(after).toBe(before);
  expect(after).toBeLessThanOrEqual(cap);
}

async function postChat(body: unknown): Promise<{ response: Response; body: LatchBody; upstreamCalls: number }> {
  const guarded = await withUpstreamSpy(async () => {
    const response = await postJson("/v1/chat/completions", body);
    const parsed = (await response.json()) as LatchBody;
    return { response, parsed };
  });
  return {
    response: guarded.result.response,
    body: guarded.result.parsed,
    upstreamCalls: guarded.upstreamCalls,
  };
}

async function dropReservations(): Promise<void> {
  await runInDurableObject(ledgerStub(), async (_instance, state) => {
    state.storage.sql.exec("DROP TABLE IF EXISTS reservations");
  });
}

async function ensureLedgerSchema(): Promise<void> {
  await runInDurableObject(ledgerStub(), async (_instance, state) => {
    for (const statement of LEDGER_SCHEMA) {
      state.storage.sql.exec(statement);
    }
  });
}

describe("fail-closed", () => {
  it("records an OpenRouter fetch so a gate that calls out cannot pass", async () => {
    const guarded = await withUpstreamSpy(() => forwardUpstream("{}", FIXTURE_OPENROUTER_KEY));
    const authorization = guarded.calls[0]?.authorization ?? null;
    if (guarded.upstreamCalls !== 1 || authorization !== `Bearer ${FIXTURE_OPENROUTER_KEY}`) {
      throw new Error(
        `upstream spy missed the OpenRouter fetch: upstreamCalls=${guarded.upstreamCalls} authorizationMatchesFixture=${String(authorization === `Bearer ${FIXTURE_OPENROUTER_KEY}`)}`,
      );
    }
    expect(guarded.upstreamCalls).toBe(1);
    expect(authorization).toBe(`Bearer ${FIXTURE_OPENROUTER_KEY}`);
  });

  it("does not treat missing usage as zero cents", () => {
    const priced = lookupModel("openai/gpt-4o-mini");
    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    expect(quoteUsage(priced.price, undefined)).toBe("missing_usage");
    expect(quoteUsage(priced.price, null)).toBe("missing_usage");
    expect(quoteUsage(priced.price, {})).toBe("missing_usage");
    expect(quoteUsage(priced.price, { prompt_tokens: 0, completion_tokens: 0 })).toBe(0);
    expect(lookupModel("no-such-model")).toEqual({ ok: false, error: "unknown_model" });
    expect(lookupModel("fixture/unpriced")).toEqual({ ok: false, error: "missing_price" });
  });

  it("does not succeed or fetch when the ledger throws", async () => {
    let outcome: Awaited<ReturnType<typeof postChat>> | undefined;
    try {
      await dropReservations();
      outcome = await postChat(
        chatBody({
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    } finally {
      await ensureLedgerSchema();
    }
    if (!outcome) {
      throw new Error("ledger throw proof did not finish");
    }
    proveRefused(outcome.response, outcome.body, outcome.upstreamCalls);
    expect(outcome.response.status).toBe(503);
    expect(outcome.body.error).toBe("ledger_unavailable");
    expect((await ledgerStub().status()).committedCents).toBe(0);
  });

  it("does not succeed or fetch for an unknown model", async () => {
    const outcome = await postChat(
      chatBody({
        model: "no-such-model",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    proveRefused(outcome.response, outcome.body, outcome.upstreamCalls);
    expect(outcome.response.status).toBe(402);
    expect(outcome.body.error).toBe("unknown_model");
    const status = await ledgerStub().status();
    expect(status.committedCents).toBe(0);
    expect(await audit(status.periodKey)).toMatchObject({ committed: 0, held: 0, rows: 0 });
  });

  it("does not succeed or fetch when the price is missing", async () => {
    const outcome = await postChat(
      chatBody({
        model: "fixture/unpriced",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    proveRefused(outcome.response, outcome.body, outcome.upstreamCalls);
    expect(outcome.response.status).toBe(402);
    expect(outcome.body.error).toBe("missing_price");
    const status = await ledgerStub().status();
    expect(status.committedCents).toBe(0);
    expect(await audit(status.periodKey)).toMatchObject({ committed: 0, held: 0, rows: 0 });
  });

  it("rejects settle above a partial hold without raising committed cents", async () => {
    const held = await ledgerStub().reserve(4, "partial-hold");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      return;
    }
    const before = await ledgerStub().status();
    expect(before.committedCents).toBe(4);
    const settled = await ledgerStub().settle(held.reservationId, 5);
    const after = await ledgerStub().status();
    proveHoldCapped(settled.ok, before.committedCents, after.committedCents, after.capCents);
    expect(settled).toMatchObject({ ok: false, error: "exceeds_hold" });
    expect(await audit(after.periodKey)).toMatchObject({ committed: 4, held: 4, rows: 1 });
    const again = await ledgerStub().settle(held.reservationId, 100);
    proveHoldCapped(again.ok, before.committedCents, (await ledgerStub().status()).committedCents, after.capCents);
    const within = await ledgerStub().settle(held.reservationId, 4);
    expect(within.ok).toBe(true);
    expect((await ledgerStub().status()).committedCents).toBe(4);
    expect((await ledgerStub().status()).committedCents).toBeLessThanOrEqual(after.capCents);
  });

  it("rejects settle above the cap hold without lifting committed cents", async () => {
    const reserved = await postJson("/reserve", { amountCents: 10, requestId: "full-hold" });
    expect(reserved.status).toBe(200);
    const reservedBody = (await reserved.json()) as { ok?: boolean; reservationId?: string };
    expect(reservedBody.ok).toBe(true);
    if (!reservedBody.reservationId) {
      throw new Error("reserve did not return a hold");
    }
    const before = await ledgerStub().status();
    expect(before.committedCents).toBe(10);
    const settled = await postJson("/settle", {
      reservationId: reservedBody.reservationId,
      actualCents: 11,
    });
    const settledBody = (await settled.json()) as LatchBody;
    const after = await ledgerStub().status();
    proveHoldCapped(settled.ok || settledBody.ok === true, before.committedCents, after.committedCents, after.capCents);
    expect(settled.status).toBe(409);
    expect(settledBody.error).toBe("exceeds_hold");
    expect(await audit(after.periodKey)).toMatchObject({ committed: 10, held: 10, rows: 1 });
  });

});
