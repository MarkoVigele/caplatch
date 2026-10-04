import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readGate } from "../src/auth";
import { FIXTURE_GATE_TOKEN, FIXTURE_OPENROUTER_KEY } from "./fixture";
import { audit, clearLedger, ledgerStub, postJson, withUpstreamSpy } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

const CHAT = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 1,
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

function chatRequest(headers: Record<string, string>, stream: boolean): Request {
  return new Request("https://caplatch.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ ...CHAT, stream }),
  });
}

async function proveChatClosed(label: string, headers: Record<string, string>, stream: boolean): Promise<void> {
  if (env.GATE_TOKEN !== FIXTURE_GATE_TOKEN) {
    throw new Error("GATE_TOKEN binding is not the test fixture");
  }
  const before = await ledgerStub().status();
  const beforeAudit = await audit(before.periodKey);
  const guarded = await withUpstreamSpy(async () => {
    const response = await exports.default.fetch(chatRequest(headers, stream));
    const text = await response.text();
    return { response, text };
  });
  const after = await ledgerStub().status();
  const afterAudit = await audit(after.periodKey);
  const contentType = guarded.result.response.headers.get("content-type") ?? "";
  let body: { ok?: boolean; error?: string } = {};
  try {
    body = JSON.parse(guarded.result.text) as { ok?: boolean; error?: string };
  } catch {
    body = {};
  }
  if (
    guarded.upstreamCalls !== 0 ||
    guarded.result.response.status !== 401 ||
    body.ok === true ||
    body.error !== "unauthorized" ||
    after.committedCents !== before.committedCents ||
    afterAudit.rows !== beforeAudit.rows ||
    afterAudit.committed !== beforeAudit.committed ||
    contentType.includes("text/event-stream") ||
    guarded.result.text.includes("data:")
  ) {
    throw new Error(
      `${label} fetched or reserved: status=${guarded.result.response.status} error=${String(body.error)} upstreamCalls=${guarded.upstreamCalls} rows=${afterAudit.rows} committed=${after.committedCents} contentType=${contentType}`,
    );
  }
  expect(guarded.result.response.status).toBe(401);
  expect(guarded.upstreamCalls).toBe(0);
  expect(afterAudit.rows).toBe(beforeAudit.rows);
}

async function proveLedgerClosed(path: string, body: unknown, headers: Record<string, string>): Promise<void> {
  const before = await ledgerStub().status();
  const beforeAudit = await audit(before.periodKey);
  const guarded = await withUpstreamSpy(async () => {
    const response = await exports.default.fetch(
      new Request(`https://caplatch.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    return { response, text };
  });
  const after = await ledgerStub().status();
  const afterAudit = await audit(after.periodKey);
  if (
    guarded.upstreamCalls !== 0 ||
    guarded.result.response.status !== 401 ||
    after.committedCents !== before.committedCents ||
    afterAudit.rows !== beforeAudit.rows
  ) {
    throw new Error(
      `${path} without a valid token fetched or reserved: status=${guarded.result.response.status} upstreamCalls=${guarded.upstreamCalls} rows=${afterAudit.rows} committed=${after.committedCents}`,
    );
  }
}

describe("GATE_TOKEN", () => {
  it("stays closed when the secret is missing and rejects a bad bearer", () => {
    expect(readGate(null, undefined)).toBe("unconfigured");
    expect(readGate(`Bearer ${FIXTURE_GATE_TOKEN}`, undefined)).toBe("unconfigured");
    expect(readGate(`Bearer ${FIXTURE_GATE_TOKEN}`, "   ")).toBe("unconfigured");
    expect(readGate(null, FIXTURE_GATE_TOKEN)).toBe("unauthorized");
    expect(readGate("", FIXTURE_GATE_TOKEN)).toBe("unauthorized");
    expect(readGate("Bearer", FIXTURE_GATE_TOKEN)).toBe("unauthorized");
    expect(readGate("Bearer ", FIXTURE_GATE_TOKEN)).toBe("unauthorized");
    expect(readGate("Bearer wrong-gate-token", FIXTURE_GATE_TOKEN)).toBe("unauthorized");
    expect(readGate(`Bearer ${FIXTURE_OPENROUTER_KEY}`, FIXTURE_GATE_TOKEN)).toBe("unauthorized");
    expect(readGate(`Bearer ${FIXTURE_GATE_TOKEN} `, FIXTURE_GATE_TOKEN)).toBe("ok");
    expect(readGate("bearer caplatch-test-gate-token", FIXTURE_GATE_TOKEN)).toBe("ok");
    expect(readGate(`Bearer ${FIXTURE_GATE_TOKEN}-extra`, FIXTURE_GATE_TOKEN)).toBe("unauthorized");
  });

  it("does not fetch or reserve a chat without a token", async () => {
    await proveChatClosed("chat without token", {}, false);
  });

  it("does not fetch or reserve a chat with the wrong token", async () => {
    await proveChatClosed("chat with wrong token", { authorization: "Bearer wrong-gate-token" }, false);
    await proveChatClosed(
      "chat with the upstream key",
      { authorization: `Bearer ${FIXTURE_OPENROUTER_KEY}` },
      false,
    );
  });

  it("does not fetch or reserve a stream without a token or with the wrong token", async () => {
    await proveChatClosed("stream without token", {}, true);
    await proveChatClosed("stream with wrong token", { authorization: "Bearer wrong-gate-token" }, true);
    await proveChatClosed("stream with an empty bearer", { authorization: "Bearer " }, true);
  });

  it("does not reserve, settle, or release without a token or with the wrong token", async () => {
    const held = await ledgerStub().reserve(4, "gate-hold");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      return;
    }
    await proveLedgerClosed("/reserve", { amountCents: 1 }, {});
    await proveLedgerClosed("/reserve", { amountCents: 1 }, { authorization: "Bearer wrong-gate-token" });
    await proveLedgerClosed("/settle", { reservationId: held.reservationId, actualCents: 1 }, {});
    await proveLedgerClosed(
      "/release",
      { reservationId: held.reservationId },
      { authorization: "Bearer " },
    );
    const after = await ledgerStub().status();
    if (after.committedCents !== 4) {
      throw new Error(`ungated ledger route changed the hold: committed=${after.committedCents}`);
    }
    const released = await ledgerStub().release(held.reservationId);
    expect(released.ok).toBe(true);
  });

  it("admits the fixture bearer on reserve and leaves GET / open", async () => {
    const reserved = await postJson("/reserve", { amountCents: 1 });
    expect(reserved.status).toBe(200);
    const root = await exports.default.fetch(new Request("https://caplatch.test/"));
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ name: "caplatch", slice: "M2c" });
    const status = await exports.default.fetch(new Request("https://caplatch.test/status"));
    expect(status.status).toBe(200);
    expect((await ledgerStub().status()).committedCents).toBe(1);
  });
});
