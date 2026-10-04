import { DurableObject } from "cloudflare:workers";
import { IDEMPOTENCY_TTL_MS } from "./constants";
import { enforcedCapCents } from "./currency";
import { isNonNegativeCents, isPositiveCents, isRequestId, isReservationId } from "./input";
import { parsePeriod, windowFor, type PeriodMode, type PeriodWindow } from "./period";
import type {
  InvalidReserve,
  LedgerStatus,
  ReleaseResult,
  ReserveRejected,
  ReserveResult,
  ReserveSuccess,
  SettleResult,
} from "./types";

type ReservationRow = {
  id: string;
  amount_cents: number;
  settled_cents: number | null;
  status: string;
  period_key: string;
};

type IdempotencyRow = {
  amount_cents: number;
  body: string;
  created_at: number;
};

type ReserveDecision = ReserveSuccess | ReserveRejected;

export const LEDGER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    amount_cents INTEGER NOT NULL,
    settled_cents INTEGER,
    status TEXT NOT NULL CHECK (status IN ('held', 'settled', 'released')),
    period_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS reservations_period ON reservations (period_key)`,
  `CREATE TABLE IF NOT EXISTS idempotency (
    request_id TEXT PRIMARY KEY,
    amount_cents INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

function asCents(value: SqlStorageValue, label: string): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
      throw new Error(`${label} is out of range`);
    }
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`${label} is not a safe integer`);
}

function committedCents(sql: SqlStorage, periodKey: string): number {
  const row = sql
    .exec<{ committed: SqlStorageValue }>(
      `SELECT COALESCE(SUM(
        CASE status
          WHEN 'held' THEN amount_cents
          WHEN 'settled' THEN settled_cents
          ELSE 0
        END
      ), 0) AS committed
      FROM reservations
      WHERE period_key = ?`,
      periodKey,
    )
    .one();
  return asCents(row.committed, "committed cents");
}

function windowInfo(
  capCents: number,
  committed: number,
  period: PeriodMode,
  window: PeriodWindow,
): LedgerStatus {
  return {
    capCents,
    committedCents: committed,
    period,
    periodKey: window.periodKey,
    resetsAt: window.resetsAt,
  };
}

function fits(committed: number, amount: number, cap: number): boolean {
  return amount <= cap - committed;
}

function invalidReserve(amountCents: number, requestId: string | null): InvalidReserve | null {
  if (!isPositiveCents(amountCents)) {
    return { ok: false, error: "invalid_amount" };
  }
  if (requestId !== null && !isRequestId(requestId)) {
    return { ok: false, error: "invalid_request_id" };
  }
  return null;
}

function readIdempotency(sql: SqlStorage, requestId: string): IdempotencyRow | null {
  const rows = sql
    .exec<IdempotencyRow>(
      `SELECT amount_cents, body, created_at FROM idempotency WHERE request_id = ?`,
      requestId,
    )
    .toArray();
  return rows[0] ?? null;
}

function isReserveDecision(value: unknown): value is ReserveDecision {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as { ok?: unknown; error?: unknown };
  return record.ok === true || (record.ok === false && record.error === "cap_exceeded");
}

function remember(sql: SqlStorage, requestId: string, amountCents: number, body: ReserveDecision, now: number): void {
  sql.exec(
    `INSERT INTO idempotency (request_id, amount_cents, body, created_at) VALUES (?, ?, ?, ?)`,
    requestId,
    amountCents,
    JSON.stringify(body),
    now,
  );
}

function findReservation(sql: SqlStorage, reservationId: string): ReservationRow | null {
  const rows = sql
    .exec<ReservationRow>(
      `SELECT id, amount_cents, settled_cents, status, period_key
       FROM reservations
       WHERE id = ?`,
      reservationId,
    )
    .toArray();
  return rows[0] ?? null;
}

function reserveInTransaction(
  sql: SqlStorage,
  input: {
    amountCents: number;
    requestId: string | null;
    capCents: number;
    period: PeriodMode;
    now: number;
    window: PeriodWindow;
  },
): ReserveResult {
  const { amountCents, requestId, capCents, period, now, window } = input;
  if (requestId !== null) {
    const existing = readIdempotency(sql, requestId);
    if (existing) {
      const age = now - asCents(existing.created_at, "idempotency age");
      if (age < IDEMPOTENCY_TTL_MS) {
        const storedAmount = asCents(existing.amount_cents, "idempotency amount");
        if (storedAmount !== amountCents) {
          return {
            ok: false,
            error: "idempotency_conflict",
            requestId,
            amountCents,
            storedAmountCents: storedAmount,
          };
        }
        const parsed: unknown = JSON.parse(existing.body);
        if (!isReserveDecision(parsed)) {
          throw new Error("stored reserve decision is corrupt");
        }
        return { ...parsed, replay: true };
      }
      sql.exec(`DELETE FROM idempotency WHERE request_id = ?`, requestId);
    }
  }

  const committed = committedCents(sql, window.periodKey);
  const info = windowInfo(capCents, committed, period, window);
  if (!fits(committed, amountCents, capCents)) {
    const rejected: ReserveRejected = { ...info, ok: false, error: "cap_exceeded", replay: false };
    if (requestId !== null) {
      remember(sql, requestId, amountCents, rejected, now);
    }
    return rejected;
  }

  const reservationId = crypto.randomUUID();
  sql.exec(
    `INSERT INTO reservations (
      id, request_id, amount_cents, settled_cents, status, period_key, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, 'held', ?, ?, ?)`,
    reservationId,
    requestId,
    amountCents,
    window.periodKey,
    now,
    now,
  );
  const reserved: ReserveSuccess = {
    ...windowInfo(capCents, committed + amountCents, period, window),
    ok: true,
    reservationId,
    amountCents,
    replay: false,
  };
  if (requestId !== null) {
    remember(sql, requestId, amountCents, reserved, now);
  }
  return reserved;
}

/**
 * One SQLite ledger for the install. Reserve, settle, and release run in
 * synchronous transactions, so concurrent callers cannot both pass the cap.
 */
export class SpendLedger extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of LEDGER_SCHEMA) {
        ctx.storage.sql.exec(statement);
      }
    });
  }

  reserve(amountCents: number, requestId: string | null = null): ReserveResult {
    const invalid = invalidReserve(amountCents, requestId);
    if (invalid) {
      return invalid;
    }
    const capCents = enforcedCapCents(this.env.CAP_CENTS, this.env.CURRENCY);
    const period = parsePeriod(this.env.PERIOD);
    const now = Date.now();
    const window = windowFor(now, period);
    return this.ctx.storage.transactionSync(() =>
      reserveInTransaction(this.ctx.storage.sql, {
        amountCents,
        requestId,
        capCents,
        period,
        now,
        window,
      }),
    );
  }

  settle(reservationId: string, actualCents: number): SettleResult {
    if (!isReservationId(reservationId)) {
      return { ok: false, error: "invalid_reservation_id" };
    }
    if (!isNonNegativeCents(actualCents)) {
      return { ok: false, error: "invalid_amount" };
    }
    const capCents = enforcedCapCents(this.env.CAP_CENTS, this.env.CURRENCY);
    const period = parsePeriod(this.env.PERIOD);
    const now = Date.now();
    const window = windowFor(now, period);
    return this.ctx.storage.transactionSync(() => {
      const row = findReservation(this.ctx.storage.sql, reservationId);
      if (!row) {
        return { ok: false, error: "not_found", reservationId };
      }
      const amount = asCents(row.amount_cents, "reserved cents");
      if (row.status === "settled") {
        const settled = asCents(row.settled_cents, "settled cents");
        if (settled === actualCents) {
          return {
            ...windowInfo(capCents, committedCents(this.ctx.storage.sql, window.periodKey), period, window),
            ok: true as const,
            reservationId,
            amountCents: amount,
            actualCents,
            replay: true,
          };
        }
        return { ok: false as const, error: "already_settled" as const, reservationId, state: "settled" };
      }
      if (row.status !== "held") {
        return { ok: false, error: "not_held", reservationId, state: row.status };
      }
      if (actualCents > amount) {
        return { ok: false, error: "exceeds_hold", reservationId };
      }
      const written = this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET status = 'settled', settled_cents = ?, updated_at = ?
         WHERE id = ? AND status = 'held' AND amount_cents >= ?`,
        actualCents,
        now,
        reservationId,
        actualCents,
      );
      if (written.rowsWritten !== 1) {
        return { ok: false, error: "exceeds_hold", reservationId };
      }
      return {
        ...windowInfo(capCents, committedCents(this.ctx.storage.sql, window.periodKey), period, window),
        ok: true as const,
        reservationId,
        amountCents: amount,
        actualCents,
        replay: false,
      };
    });
  }

  release(reservationId: string): ReleaseResult {
    if (!isReservationId(reservationId)) {
      return { ok: false, error: "invalid_reservation_id" };
    }
    const capCents = enforcedCapCents(this.env.CAP_CENTS, this.env.CURRENCY);
    const period = parsePeriod(this.env.PERIOD);
    const now = Date.now();
    const window = windowFor(now, period);
    return this.ctx.storage.transactionSync(() => {
      const row = findReservation(this.ctx.storage.sql, reservationId);
      if (!row) {
        return { ok: false, error: "not_found", reservationId };
      }
      const amount = asCents(row.amount_cents, "reserved cents");
      if (row.status === "released") {
        return {
          ...windowInfo(capCents, committedCents(this.ctx.storage.sql, window.periodKey), period, window),
          ok: true as const,
          reservationId,
          amountCents: amount,
          replay: true,
        };
      }
      if (row.status !== "held") {
        return { ok: false, error: "not_held", reservationId, state: row.status };
      }
      this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET status = 'released', updated_at = ?
         WHERE id = ? AND status = 'held'`,
        now,
        reservationId,
      );
      return {
        ...windowInfo(capCents, committedCents(this.ctx.storage.sql, window.periodKey), period, window),
        ok: true as const,
        reservationId,
        amountCents: amount,
        replay: false,
      };
    });
  }

  status(): LedgerStatus {
    const capCents = enforcedCapCents(this.env.CAP_CENTS, this.env.CURRENCY);
    const period = parsePeriod(this.env.PERIOD);
    const window = windowFor(Date.now(), period);
    const committed = this.ctx.storage.transactionSync(() =>
      committedCents(this.ctx.storage.sql, window.periodKey),
    );
    return windowInfo(capCents, committed, period, window);
  }
}
