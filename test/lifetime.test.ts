import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { audit, clearLedger, ledgerStub } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

describe("lifetime period", () => {
  it("treats PERIOD=none as one bucket that does not reset", async () => {
    const status = await ledgerStub().status();
    expect(status.period).toBe("lifetime");
    expect(status.periodKey).toBe("lifetime");
    expect(status.resetsAt).toBeNull();
    expect(status.capCents).toBe(10);

    await runInDurableObject(ledgerStub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO reservations (
          id, request_id, amount_cents, settled_cents, status, period_key, created_at, updated_at
        ) VALUES (?, NULL, 100, NULL, 'held', '2026-10', ?, ?)`,
        "00000000-0000-4000-8000-000000000002",
        Date.now(),
        Date.now(),
      );
    });

    const reserved = await ledgerStub().reserve(10, "life");
    expect(reserved.ok).toBe(true);
    const blocked = await ledgerStub().reserve(1, "life-over");
    expect(blocked).toMatchObject({
      ok: false,
      error: "cap_exceeded",
      committedCents: 10,
      capCents: 10,
      period: "lifetime",
      resetsAt: null,
    });
    expect(await audit("lifetime")).toMatchObject({ committed: 10, held: 10, rows: 1 });
    expect((await audit("2026-10")).committed).toBe(100);

    const replay = await ledgerStub().reserve(10, "life");
    expect(reserved.ok && replay.ok).toBe(true);
    if (!reserved.ok || !replay.ok) {
      return;
    }
    expect(replay.replay).toBe(true);
    expect(replay.reservationId).toBe(reserved.reservationId);
    expect((await ledgerStub().status()).committedCents).toBe(10);
  });
});
