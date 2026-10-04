import { parseCapCents } from "./period";

/**
 * Fixed latch rate: one euro is 110 US cents.
 * Not a live foreign-exchange quote, and not fetched.
 */
export const US_CENTS_PER_EURO = 110;

const EURO_CENTS = 100;

export type LatchCurrency = "usd" | "eur";

export type CurrencyRead =
  | { ok: true; currency: LatchCurrency }
  | { ok: false; error: "unsupported_currency" };

/** Missing and blank match usd. Only `usd` and `eur` are accepted. */
export function readCurrency(value: unknown): CurrencyRead {
  if (value === undefined) {
    return { ok: true, currency: "usd" };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "unsupported_currency" };
  }
  const token = value.trim().toLowerCase();
  if (token.length === 0 || token === "usd") {
    return { ok: true, currency: "usd" };
  }
  if (token === "eur") {
    return { ok: true, currency: "eur" };
  }
  return { ok: false, error: "unsupported_currency" };
}

/**
 * Cap in US cents. usd returns CAP_CENTS unchanged.
 * eur maps euro-cents at 110 US cents per euro: 100 euro-cents → 110 US cents.
 */
export function capInUsCents(capCents: number, currency: LatchCurrency): number {
  if (currency === "usd") {
    return capCents;
  }
  if (!Number.isSafeInteger(capCents) || capCents < 1) {
    throw new Error("EUR cap does not convert to whole US cents");
  }
  const product = capCents * US_CENTS_PER_EURO;
  if (!Number.isSafeInteger(product) || product % EURO_CENTS !== 0) {
    throw new Error("EUR cap does not convert to whole US cents");
  }
  return product / EURO_CENTS;
}

/** US-cent cap the ledger enforces. Unsupported currencies throw before a hold. */
export function enforcedCapCents(capRaw: unknown, currencyRaw: unknown): number {
  const capCents = parseCapCents(capRaw);
  const currency = readCurrency(currencyRaw);
  if (!currency.ok) {
    throw new Error("CURRENCY must be usd or eur");
  }
  return capInUsCents(capCents, currency.currency);
}
