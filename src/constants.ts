/** How long a request id replays the original reserve decision. */
export const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

export const REQUEST_ID_HEADER = "X-Caplatch-Request-Id";

/** One install, one cap, one Durable Object. */
export const LEDGER_NAME = "ledger";

/** Output-token ceiling used when a call omits max_tokens. */
export const MAX_OUTPUT_TOKENS = 256;

/**
 * M1b refuses before any upstream byte. The OpenRouter proxy is a later slice.
 * The call site stays after the fail-closed gates so a refusal cannot reach it.
 */
export const UPSTREAM_ENABLED = false;
