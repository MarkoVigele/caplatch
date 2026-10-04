import { estimateCallCents, lookupModel, quoteUsage } from "./prices";
import type { ReserveResult, SettleResult, SettleSuccess } from "./types";

type LedgerCall = {
  reserve(amountCents: number, requestId: string | null): ReserveResult | Promise<ReserveResult>;
  settle(reservationId: string, actualCents: number): SettleResult | Promise<SettleResult>;
};

export type ChatDecision =
  | { kind: "refuse"; status: number; body: unknown }
  | { kind: "accepted"; payload: string; result: SettleSuccess };

function refusalStatus(error: string | undefined): number {
  switch (error) {
    case "cap_exceeded":
      return 402;
    case "not_found":
      return 404;
    case "idempotency_conflict":
    case "already_settled":
    case "not_held":
    case "exceeds_hold":
      return 409;
    default:
      return 400;
  }
}

function refuse(status: number, body: unknown): ChatDecision {
  return { kind: "refuse", status, body };
}

/**
 * Model, price, ledger, then usage. Nothing here calls upstream.
 * Missing usage keeps the reservation and does not settle it as zero.
 */
export async function decideChat(
  ledgerCall: LedgerCall,
  body: Record<string, unknown>,
  requestId: string | null,
): Promise<ChatDecision> {
  const looked = lookupModel(body.model);
  if (!looked.ok) {
    return refuse(402, { ok: false, error: looked.error });
  }

  const amountCents = estimateCallCents(looked.price, body.messages, body.max_tokens);
  const reserved = await ledgerCall.reserve(amountCents, requestId);
  if (!reserved.ok) {
    return refuse(refusalStatus(reserved.error), reserved);
  }

  const actualCents = quoteUsage(looked.price, body.usage);
  if (actualCents === "missing_usage") {
    return refuse(402, {
      ok: false,
      error: "missing_usage",
      reservationId: reserved.reservationId,
      amountCents: reserved.amountCents,
      capCents: reserved.capCents,
      committedCents: reserved.committedCents,
      resetsAt: reserved.resetsAt,
    });
  }

  const settled = await ledgerCall.settle(reserved.reservationId, actualCents);
  if (!settled.ok) {
    return refuse(refusalStatus(settled.error), settled);
  }
  return { kind: "accepted", payload: JSON.stringify(body), result: settled };
}
