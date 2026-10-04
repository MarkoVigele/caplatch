/** Fake upstream key for the fetch spy. Not a credential and not read by production. */
export const FIXTURE_OPENROUTER_KEY = "sk-or-v1-caplatch-test-fixture";

/** Fake gate token for tests. Not a live Worker secret. */
export const FIXTURE_GATE_TOKEN = "caplatch-test-gate-token";

/** A client-supplied value that must never be sent as the upstream key. */
export const CLIENT_SUPPLIED_KEY = "sk-client-supplied-not-the-upstream-key";
