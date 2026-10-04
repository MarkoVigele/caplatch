import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA } from "../src/ledger";
import { lookupModel, quoteUsage } from "../src/prices";
import { forwardUpstream } from "../src/upstream";
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

async function readHold(): Promise<{ id: string; amount: number; status: string; settled: number | null } | null> {
  return runInDurableObject(ledgerStub(), async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ id: string; amount_cents: number; status: string; settled_cents: number | null }>(
        `SELECT id, amount_cents, status, settled_cents FROM reservations`,
      )
      .toArray();
    if (rows.length !== 1) {
      return null;
    }
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      amount: Number(row.amount_cents),
      status: String(row.status),
      settled: row.settled_cents === null ? null : Number(row.settled_cents),
    };
  });
}

describe("fail-closed", () => {
  it("records an OpenRouter fetch so a gate that calls out cannot pass", async () => {
    const guarded = await withUpstreamSpy(() => forwardUpstream("{}"));
    if (guarded.upstreamCalls === 0) {
      throw new Error("upstream spy did not see a fetch to OpenRouter");
    }
    expect(guarded.upstreamCalls).toBe(1);
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

  it("does not succeed or fetch when usage is missing, and keeps the hold", async () => {
    const outcome = await postChat(chatBody());
    proveRefused(outcome.response, outcome.body, outcome.upstreamCalls);
    expect(outcome.response.status).toBe(402);
    expect(outcome.body.error).toBe("missing_usage");
    expect(outcome.body).not.toMatchObject({ ok: true, actualCents: 0 });

    const row = await readHold();
    expect(row).not.toBeNull();
    if (!row) {
      return;
    }
    expect(row.status).toBe("held");
    expect(row.settled).toBeNull();
    expect(row.amount).toBeGreaterThan(0);
    const status = await ledgerStub().status();
    expect(status.committedCents).toBe(row.amount);
    expect(status.committedCents).toBeLessThanOrEqual(status.capCents);
    const settled = await ledgerStub().settle(row.id, row.amount);
    expect(settled.ok).toBe(true);
    if (!settled.ok) {
      return;
    }
    expect(settled.replay).toBe(false);
    expect(settled.actualCents).toBe(row.amount);
    expect((await ledgerStub().status()).committedCents).toBeLessThanOrEqual(status.capCents);
  });

  it("does not call upstream when usage is present", async () => {
    const outcome = await postChat(
      chatBody({
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    if (outcome.upstreamCalls !== 0) {
      throw new Error(`upstream fetch was called ${outcome.upstreamCalls} time(s)`);
    }
    expect(outcome.upstreamCalls).toBe(0);
    expect(outcome.response.status).toBe(200);
    expect(outcome.body.ok).toBe(true);
    const status = await ledgerStub().status();
    expect(status.committedCents).toBeGreaterThan(0);
    expect(status.committedCents).toBeLessThanOrEqual(status.capCents);
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

  it("does not fetch or lift the cap when quoted usage exceeds the hold", async () => {
    const outcome = await postChat(
      chatBody({
        usage: { prompt_tokens: 0, completion_tokens: 5_000_000 },
      }),
    );
    const after = await ledgerStub().status();
    if (
      outcome.response.ok ||
      outcome.body.ok === true ||
      outcome.upstreamCalls !== 0 ||
      after.committedCents > after.capCents
    ) {
      throw new Error(
        `usage above the hold was not fail-closed: status=${outcome.response.status} ok=${String(outcome.body.ok)} upstreamCalls=${outcome.upstreamCalls} committed=${after.committedCents} cap=${after.capCents}`,
      );
    }
    expect(outcome.body.error).toBe("exceeds_hold");
    expect(outcome.upstreamCalls).toBe(0);
    expect(after.committedCents).toBeGreaterThan(0);
    expect(after.committedCents).toBeLessThanOrEqual(after.capCents);
    const row = await readHold();
    expect(row?.status).toBe("held");
    expect(row?.settled).toBeNull();
    if (row) {
      expect(after.committedCents).toBe(row.amount);
    }
  });
});
