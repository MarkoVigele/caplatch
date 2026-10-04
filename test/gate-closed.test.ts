import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_GATE_TOKEN, FIXTURE_OPENROUTER_KEY } from "./fixture";
import { audit, clearLedger, ledgerStub, withUpstreamSpy } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

const CHAT = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 1,
  stream: true,
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

function configuredGate(): string | undefined {
  try {
    const value = env.GATE_TOKEN;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function proveClosed(label: string, authorization?: string): Promise<void> {
  const secret = configuredGate();
  if (typeof secret === "string" && secret.trim().length > 0) {
    throw new Error("GATE_TOKEN is set; this proof needs the secret unset");
  }
  if (env.UPSTREAM_ENABLED !== "true" || env.OPENROUTER_API_KEY !== FIXTURE_OPENROUTER_KEY) {
    throw new Error("upstream is not armed, so a missed gate would not fetch");
  }
  const before = await ledgerStub().status();
  const beforeAudit = await audit(before.periodKey);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  const guarded = await withUpstreamSpy(async () => {
    const response = await exports.default.fetch(
      new Request("https://caplatch.test/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(CHAT),
      }),
    );
    const text = await response.text();
    return { response, text };
  });
  const after = await ledgerStub().status();
  const afterAudit = await audit(after.periodKey);
  let body: { ok?: boolean; error?: string } = {};
  try {
    body = JSON.parse(guarded.result.text) as { ok?: boolean; error?: string };
  } catch {
    body = {};
  }
  if (
    guarded.upstreamCalls !== 0 ||
    guarded.result.response.status !== 401 ||
    body.error !== "gate_unconfigured" ||
    after.committedCents !== before.committedCents ||
    afterAudit.rows !== beforeAudit.rows ||
    guarded.result.text.includes("data:")
  ) {
    throw new Error(
      `${label} fetched or reserved while the secret is unset: status=${guarded.result.response.status} error=${String(body.error)} upstreamCalls=${guarded.upstreamCalls} rows=${afterAudit.rows} committed=${after.committedCents}`,
    );
  }
  expect(guarded.upstreamCalls).toBe(0);
}

describe("unset GATE_TOKEN", () => {
  it("keeps chat closed with no fetch and no reservation", async () => {
    await proveClosed("chat without token");
    await proveClosed("chat with the fixture token", `Bearer ${FIXTURE_GATE_TOKEN}`);
    await proveClosed("chat with the wrong token", "Bearer wrong-gate-token");
  });

  it("does not reserve when the secret is unset", async () => {
    const before = await ledgerStub().status();
    const response = await exports.default.fetch(
      new Request("https://caplatch.test/reserve", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${FIXTURE_GATE_TOKEN}` },
        body: JSON.stringify({ amountCents: 1 }),
      }),
    );
    const after = await ledgerStub().status();
    const stored = await audit(after.periodKey);
    if (response.status !== 401 || after.committedCents !== before.committedCents || stored.rows !== 0) {
      throw new Error(
        `unset secret still reserved: status=${response.status} committed=${after.committedCents} rows=${stored.rows}`,
      );
    }
    const root = await exports.default.fetch(new Request("https://caplatch.test/"));
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ name: "caplatch", slice: "M2c" });
    const status = await exports.default.fetch(new Request("https://caplatch.test/status"));
    expect(status.status).toBe(200);
  });
});
