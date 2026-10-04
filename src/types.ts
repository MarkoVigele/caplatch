import type { PeriodMode } from "./period";

export type WindowInfo = {
  capCents: number;
  committedCents: number;
  period: PeriodMode;
  periodKey: string;
  resetsAt: string | null;
};

export type ReserveSuccess = WindowInfo & {
  ok: true;
  reservationId: string;
  amountCents: number;
  replay: boolean;
};

export type ReserveRejected = WindowInfo & {
  ok: false;
  error: "cap_exceeded";
  replay: boolean;
};

export type IdempotencyConflict = {
  ok: false;
  error: "idempotency_conflict";
  requestId: string;
  amountCents: number;
  storedAmountCents: number;
};

export type InvalidReserve = {
  ok: false;
  error: "invalid_amount" | "invalid_request_id";
};

export type ReserveResult =
  | ReserveSuccess
  | ReserveRejected
  | IdempotencyConflict
  | InvalidReserve;

export type SettleSuccess = WindowInfo & {
  ok: true;
  reservationId: string;
  amountCents: number;
  actualCents: number;
  replay: boolean;
};

export type SettleFailure = {
  ok: false;
  error: "invalid_amount" | "invalid_reservation_id" | "not_found" | "not_held" | "already_settled";
  reservationId?: string;
  state?: string;
};

export type SettleResult = SettleSuccess | SettleFailure;

export type ReleaseSuccess = WindowInfo & {
  ok: true;
  reservationId: string;
  amountCents: number;
  replay: boolean;
};

export type ReleaseFailure = {
  ok: false;
  error: "invalid_reservation_id" | "not_found" | "not_held";
  reservationId?: string;
  state?: string;
};

export type ReleaseResult = ReleaseSuccess | ReleaseFailure;

export type LedgerStatus = WindowInfo;
