import { estimateCallCents, lookupModel, quoteUsage, type TokenPrice } from "./prices";
import { emptyByteStream, forwardSse } from "./stream";
import type { UpstreamMode } from "./upstream";
import type { ReserveResult, ReserveSuccess, SettleResult } from "./types";

type LedgerCall = {
  reserve(amountCents: number, requestId: string | null): ReserveResult | Promise<ReserveResult>;
  settle(reservationId: string, actualCents: number): SettleResult | Promise<SettleResult>;
};

export type ProxyResult =
  | { kind: "refuse"; status: number; body: unknown }
  | { kind: "upstream"; status: number; contentType: string; body: string }
  | { kind: "stream"; status: number; contentType: string; body: ReadableStream<Uint8Array> };

const NOT_FORWARDED = new Set([
  "usage",
  "requestId",
  "api_key",
  "apiKey",
  "openrouter_api_key",
  "authorization",
  "Authorization",
]);

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

function refuse(status: number, body: unknown): ProxyResult {
  return { kind: "refuse", status, body };
}

function outboundPayload(body: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (NOT_FORWARDED.has(key)) {
      continue;
    }
    copy[key] = value;
  }
  return JSON.stringify(copy);
}

function usageFrom(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).usage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Settle this many cents. Never releases. A failed settle leaves the hold. */
async function settleCents(ledgerCall: LedgerCall, reservationId: string, cents: number): Promise<void> {
  await ledgerCall.settle(reservationId, cents);
}

/**
 * Model and price, then a pessimistic reserve, then one upstream call.
 * The reserve finishes before that call starts, so no request byte leaves
 * until the hold exists. Client `usage` is ignored. A non-stream bill is
 * the OpenRouter JSON `usage`. A stream bill is the `usage` on the last
 * SSE chunk, and those bytes are passed through. Missing usage charges
 * the full hold. A quote above the hold stays `exceeds_hold` and does
 * not fetch again. A thrown fetch or stream charges the hold once.
 */
export async function proxyChat(
  ledgerCall: LedgerCall,
  body: Record<string, unknown>,
  requestId: string | null,
  mode: UpstreamMode,
): Promise<ProxyResult> {
  const looked = lookupModel(body.model);
  if (!looked.ok) {
    return refuse(402, { ok: false, error: looked.error });
  }
  if (mode.kind === "off") {
    return refuse(503, { ok: false, error: mode.error });
  }

  const amountCents = estimateCallCents(looked.price, body.messages, body.max_tokens);
  const reserved = await ledgerCall.reserve(amountCents, requestId);
  if (!reserved.ok) {
    return refuse(refusalStatus(reserved.error), reserved);
  }
  if (reserved.replay) {
    return refuse(409, { ok: false, error: "idempotency_replay" });
  }

  const pending = mode.call(outboundPayload(body));
  if (body.stream === true) {
    return billStream(ledgerCall, looked.price, reserved, pending);
  }
  return billOneCall(ledgerCall, looked.price, reserved, pending);
}

async function billOneCall(
  ledgerCall: LedgerCall,
  price: TokenPrice,
  reserved: ReserveSuccess,
  pending: Promise<Response>,
): Promise<ProxyResult> {
  let response: Response;
  try {
    response = await pending;
  } catch {
    await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
    return refuse(502, { ok: false, error: "upstream_unavailable" });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
    return refuse(502, { ok: false, error: "upstream_unavailable" });
  }

  const actual = quoteUsage(price, usageFrom(text));
  if (actual === "missing_usage") {
    await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
  } else {
    await settleCents(ledgerCall, reserved.reservationId, actual);
  }

  const contentType = response.headers.get("content-type") ?? "application/json";
  return { kind: "upstream", status: response.status, contentType, body: text };
}

async function billStream(
  ledgerCall: LedgerCall,
  price: TokenPrice,
  reserved: ReserveSuccess,
  pending: Promise<Response>,
): Promise<ProxyResult> {
  let response: Response;
  try {
    response = await pending;
  } catch {
    await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
    return refuse(502, { ok: false, error: "upstream_unavailable" });
  }

  const contentType = response.headers.get("content-type") ?? "text/event-stream";
  const source = response.body;
  if (!source) {
    await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
    return { kind: "stream", status: response.status, contentType, body: emptyByteStream() };
  }

  const body = forwardSse(source, async (usage, failed) => {
    if (failed) {
      await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
      return;
    }
    const actual = quoteUsage(price, usage);
    if (actual === "missing_usage") {
      await settleCents(ledgerCall, reserved.reservationId, reserved.amountCents);
      return;
    }
    await settleCents(ledgerCall, reserved.reservationId, actual);
  });
  return { kind: "stream", status: response.status, contentType, body };
}
