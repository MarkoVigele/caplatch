import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_TTL_MS, REQUEST_ID_HEADER } from "../src/constants";
import { windowFor } from "../src/period";
import type { ReserveResult } from "../src/types";
import { audit, clearLedger, getJson, ledgerStub, postJson } from "./helpers";

const CAP = 10;

beforeEach(async () => {
  await clearLedger();
});

async function reserveHttp(
  amountCents: number,
  requestId?: string,
): Promise<{ status: number; body: ReserveResult }> {
  const headers: Record<string, string> = {};
  if (requestId !== undefined) {
    headers[REQUEST_ID_HEADER] = requestId;
  }
  const response = await postJson("/reserve", { amountCents }, headers);
  return { status: response.status, body: (await response.json()) as ReserveResult };
}

describe("ledger", () => {
  it("reports the UTC month and the test cap", async () => {
    const response = await exportsStatus();
    expect(response.capCents).toBe(CAP);
    expect(response.period).toBe("month");
    expect(response.resetsAt).toBe(windowFor(Date.now(), "month").resetsAt);
    const root = await fetchRoot();
    expect(root).toEqual({ name: "caplatch", slice: "M1a" });
  });

  it("holds cents, settles the actual, and releases the rest", async () => {
    const first = await ledgerStub().reserve(4, "hold-a");
    const second = await ledgerStub().reserve(4, "hold-b");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    const settled = await ledgerStub().settle(first.reservationId, 1);
    expect(settled).toMatchObject({ ok: true, actualCents: 1, replay: false });
    expect(await ledgerStub().settle(first.reservationId, 1)).toMatchObject({
      ok: true,
      replay: true,
      actualCents: 1,
    });
    expect(await ledgerStub().settle(first.reservationId, 2)).toMatchObject({
      ok: false,
      error: "already_settled",
    });
    expect((await ledgerStub().status()).committedCents).toBe(5);

    const released = await ledgerStub().release(second.reservationId);
    expect(released).toMatchObject({ ok: true, replay: false });
    expect(await ledgerStub().release(second.reservationId)).toMatchObject({ ok: true, replay: true });
    expect((await ledgerStub().status()).committedCents).toBe(1);
    expect(await ledgerStub().release(first.reservationId)).toMatchObject({ ok: false, error: "not_held" });
    expect(await ledgerStub().settle("00000000-0000-4000-8000-000000000099", 1)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("rejects a reserve that does not fit, including after a settle above the hold", async () => {
    const held = await ledgerStub().reserve(10, "whole-cap");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      return;
    }
    const blocked = await ledgerStub().reserve(1, "over");
    expect(blocked).toMatchObject({
      ok: false,
      error: "cap_exceeded",
      capCents: CAP,
      committedCents: CAP,
    });
    if (blocked.ok || blocked.error !== "cap_exceeded") {
      return;
    }
    expect(blocked.resetsAt).toBe(windowFor(Date.now(), "month").resetsAt);
    expect(await ledgerStub().settle(held.reservationId, 12)).toMatchObject({ ok: true, actualCents: 12 });
    expect((await ledgerStub().status()).committedCents).toBe(12);
    expect(await ledgerStub().reserve(1, "still-over")).toMatchObject({ ok: false, error: "cap_exceeded" });
    expect((await ledgerStub().status()).committedCents).toBe(12);
  });

  it("ignores a previous UTC month when counting the cap", async () => {
    const current = await ledgerStub().status();
    const [yearText, monthText] = current.periodKey.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const previousKey = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
    await runInDurableObject(ledgerStub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO reservations (
          id, request_id, amount_cents, settled_cents, status, period_key, created_at, updated_at
        ) VALUES (?, NULL, 50, NULL, 'held', ?, ?, ?)`,
        "00000000-0000-4000-8000-000000000001",
        previousKey,
        Date.now(),
        Date.now(),
      );
    });
    const reserved = await ledgerStub().reserve(1, "new-month");
    expect(reserved).toMatchObject({ ok: true, committedCents: 1 });
    expect(await audit(current.periodKey)).toMatchObject({ committed: 1, held: 1, rows: 1 });
    expect(await audit(previousKey)).toMatchObject({ committed: 50, held: 50, rows: 1 });
  });

  it("replays a request id within the TTL and does not hold twice", async () => {
    const first = await reserveHttp(1, "retry-1");
    const second = await reserveHttp(1, "retry-1");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.ok && second.body.ok).toBe(true);
    if (!first.body.ok || !second.body.ok) {
      return;
    }
    expect(second.body.replay).toBe(true);
    expect(second.body.reservationId).toBe(first.body.reservationId);
    expect((await ledgerStub().status()).committedCents).toBe(1);

    const conflict = await postJson(
      "/reserve",
      { amountCents: 2, requestId: "retry-1" },
      { [REQUEST_ID_HEADER]: "retry-1" },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, error: "idempotency_conflict" });

    const mismatch = await postJson(
      "/reserve",
      { amountCents: 1, requestId: "body-id" },
      { [REQUEST_ID_HEADER]: "header-id" },
    );
    expect(mismatch.status).toBe(400);

    const filled = await ledgerStub().reserve(9, "fill-rest");
    expect(filled.ok).toBe(true);
    const rejected = await reserveHttp(1, "nope");
    expect(rejected.status).toBe(402);
    expect(rejected.body).toMatchObject({ ok: false, error: "cap_exceeded", replay: false });
    if (!filled.ok) {
      return;
    }
    expect((await ledgerStub().release(filled.reservationId)).ok).toBe(true);
    const replayedReject = await reserveHttp(1, "nope");
    expect(replayedReject.status).toBe(402);
    expect(replayedReject.body).toMatchObject({ ok: false, error: "cap_exceeded", replay: true });
    expect((await ledgerStub().status()).committedCents).toBe(1);
    const fresh = await reserveHttp(1, "fresh");
    expect(fresh.status).toBe(200);
    expect((await ledgerStub().status()).committedCents).toBe(2);
  });

  it("reserves again after the idempotency TTL", async () => {
    const first = await ledgerStub().reserve(1, "again");
    expect(first.ok).toBe(true);
    await runInDurableObject(ledgerStub(), async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE idempotency SET created_at = ? WHERE request_id = ?`,
        Date.now() - IDEMPOTENCY_TTL_MS - 1000,
        "again",
      );
    });
    const second = await ledgerStub().reserve(1, "again");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.replay).toBe(false);
    expect(second.reservationId).not.toBe(first.reservationId);
    expect((await ledgerStub().status()).committedCents).toBe(2);
  });

  it("rejects amounts that are not positive integer cents", async () => {
    expect((await reserveHttp(0)).status).toBe(400);
    expect((await reserveHttp(1.5)).status).toBe(400);
    expect((await reserveHttp(-1)).status).toBe(400);
    const missing = await postJson("/reserve", {});
    expect(missing.status).toBe(400);
    expect((await ledgerStub().status()).committedCents).toBe(0);
  });

  it("50 concurrent 1-cent reserves against a 10-cent cap never exceed the cap", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_value, index) => reserveHttp(1, `burst-${index}`)),
    );
    const accepted = results.filter((result) => result.body.ok);
    const rejected = results.filter((result) => !result.body.ok);
    const heldCents = accepted.reduce((sum, result) => {
      return sum + (result.body.ok ? result.body.amountCents : 0);
    }, 0);
    const status = await ledgerStub().status();
    const stored = await audit(status.periodKey);

    console.log(
      `concurrent reserves: accepted=${accepted.length} rejected=${rejected.length} heldCents=${heldCents} capCents=${status.capCents} sqlCommitted=${stored.committed} sqlHeld=${stored.held} sqlRows=${stored.rows}`,
    );

    expect(status.capCents).toBe(CAP);
    expect(accepted).toHaveLength(CAP);
    expect(rejected).toHaveLength(50 - CAP);
    expect(heldCents).toBeLessThanOrEqual(CAP);
    expect(heldCents).toBe(CAP);
    expect(stored.committed).toBeLessThanOrEqual(CAP);
    expect(stored.committed).toBe(heldCents);
    expect(stored.held).toBe(heldCents);
    expect(stored.rows).toBe(CAP);
    expect(new Set(accepted.map((result) => (result.body.ok ? result.body.reservationId : ""))).size).toBe(CAP);
    expect(
      rejected.every(
        (result) => result.status === 402 && result.body.ok === false && result.body.error === "cap_exceeded",
      ),
    ).toBe(true);
    expect(accepted.every((result) => result.status === 200)).toBe(true);
    expect(status.committedCents).toBe(heldCents);
  });

  it("50 concurrent reserves fill only the cents still under the cap", async () => {
    const seed = await ledgerStub().reserve(6, "already-held");
    expect(seed.ok).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_value, index) => ledgerStub().reserve(1, `remain-${index}`)),
    );
    const accepted = results.filter((result) => result.ok);
    const acceptedCents = accepted.reduce((sum, result) => sum + (result.ok ? result.amountCents : 0), 0);
    const status = await ledgerStub().status();
    const stored = await audit(status.periodKey);

    console.log(
      `remaining reserves: accepted=${accepted.length} acceptedCents=${acceptedCents} committedCents=${status.committedCents} capCents=${status.capCents} sqlCommitted=${stored.committed}`,
    );

    expect(accepted).toHaveLength(4);
    expect(acceptedCents).toBe(4);
    expect(status.committedCents).toBe(CAP);
    expect(status.committedCents).toBeLessThanOrEqual(status.capCents);
    expect(stored.committed).toBe(CAP);
    expect(results.filter((result) => !result.ok)).toHaveLength(46);
  });

  it("collapses concurrent reserves that share one request id into a single hold", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => ledgerStub().reserve(1, "same-attempt")));
    const accepted = results.filter((result) => result.ok);
    expect(accepted).toHaveLength(20);
    const ids = new Set(accepted.map((result) => (result.ok ? result.reservationId : "")));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.ok && result.replay).length).toBe(19);
    expect((await ledgerStub().status()).committedCents).toBe(1);
  });
});

async function exportsStatus() {
  const response = await getJson("/status");
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    capCents: number;
    committedCents: number;
    period: string;
    periodKey: string;
    resetsAt: string | null;
  }>;
}

async function fetchRoot(): Promise<unknown> {
  const response = await getJson("/");
  expect(response.status).toBe(200);
  return response.json();
}
