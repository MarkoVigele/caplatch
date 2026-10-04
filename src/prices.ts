import { isNonNegativeCents } from "./input";
import { MAX_OUTPUT_TOKENS } from "./constants";

const TOKENS_PER_MILLION = 1_000_000;

export type TokenPrice = {
  promptCentsPerMillion: number;
  completionCentsPerMillion: number;
};

const PRICES: Readonly<Record<string, TokenPrice>> = {
  "openai/gpt-4o-mini": { promptCentsPerMillion: 15, completionCentsPerMillion: 60 },
  "openai/gpt-4o": { promptCentsPerMillion: 250, completionCentsPerMillion: 1000 },
};

/** Present in the latch, with no rates. A blank row must not be treated as free. */
const UNPRICED_MODELS = new Set<string>(["fixture/unpriced"]);

export type ModelLookup =
  | { ok: true; model: string; price: TokenPrice }
  | { ok: false; error: "unknown_model" | "missing_price" };

function isBillable(price: TokenPrice): boolean {
  const prompt = price.promptCentsPerMillion;
  const completion = price.completionCentsPerMillion;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion)) {
    return false;
  }
  if (prompt < 0 || completion < 0) {
    return false;
  }
  return prompt > 0 || completion > 0;
}

export function lookupModel(model: unknown): ModelLookup {
  if (typeof model !== "string") {
    return { ok: false, error: "unknown_model" };
  }
  const key = model.trim();
  if (key.length === 0) {
    return { ok: false, error: "unknown_model" };
  }
  const price = PRICES[key];
  if (price) {
    if (!isBillable(price)) {
      return { ok: false, error: "missing_price" };
    }
    return { ok: true, model: key, price };
  }
  if (UNPRICED_MODELS.has(key)) {
    return { ok: false, error: "missing_price" };
  }
  return { ok: false, error: "unknown_model" };
}

function ceilTokenCents(tokens: number, centsPerMillion: number): number {
  if (tokens === 0 || centsPerMillion === 0) {
    return 0;
  }
  const product = tokens * centsPerMillion;
  if (!Number.isSafeInteger(product)) {
    throw new Error("token price exceeds a safe integer");
  }
  return Math.floor((product + TOKENS_PER_MILLION - 1) / TOKENS_PER_MILLION);
}

function estimateInputTokens(messages: unknown): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 1;
  }
  let chars = 0;
  for (const message of messages) {
    const encoded = JSON.stringify(message);
    if (typeof encoded === "string") {
      chars += encoded.length;
    }
  }
  const tokens = Math.ceil(chars / 4);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 1;
}

function estimateOutputTokens(maxTokens: unknown): number {
  if (typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    return maxTokens;
  }
  return MAX_OUTPUT_TOKENS;
}

/** Pessimistic cents for a priced call. At least one cent, so a hold cannot be free. */
export function estimateCallCents(price: TokenPrice, messages: unknown, maxTokens: unknown): number {
  const cents =
    ceilTokenCents(estimateInputTokens(messages), price.promptCentsPerMillion) +
    ceilTokenCents(estimateOutputTokens(maxTokens), price.completionCentsPerMillion);
  if (!Number.isSafeInteger(cents) || cents < 1) {
    throw new Error("estimate is not a positive cent amount");
  }
  return cents;
}

function isTokenCount(value: unknown): value is number {
  return isNonNegativeCents(value);
}

/**
 * Cents implied by provider usage. Missing counts are not zero: zero is only
 * returned when both token counts are present and are zero.
 */
export function quoteUsage(price: TokenPrice, usage: unknown): number | "missing_usage" {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return "missing_usage";
  }
  const record = usage as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(record, "prompt_tokens") ||
    !Object.prototype.hasOwnProperty.call(record, "completion_tokens")
  ) {
    return "missing_usage";
  }
  const prompt = record.prompt_tokens;
  const completion = record.completion_tokens;
  if (!isTokenCount(prompt) || !isTokenCount(completion)) {
    return "missing_usage";
  }
  const cents =
    ceilTokenCents(prompt, price.promptCentsPerMillion) +
    ceilTokenCents(completion, price.completionCentsPerMillion);
  if (!Number.isSafeInteger(cents) || cents < 0) {
    return "missing_usage";
  }
  return cents;
}
