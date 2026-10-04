import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER } from "../src/constants";
import { estimateCallCents, lookupModel, quoteUsage } from "../src/prices";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../src/upstream";
import { CLIENT_SUPPLIED_KEY, FIXTURE_GATE_TOKEN, FIXTURE_OPENROUTER_KEY } from "./fixture";
import { audit, clearLedger, ledgerStub, postJson, withUpstreamSpy } from "./helpers";

beforeEach(async () => {
  await clearLedger();
});

const MESSAGES = [{ role: "user", content: "hi" }];

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openai/gpt-4o-mini",
    messages: MESSAGES,
    max_tokens: 1,
    stream: true,
    ...extra,
  };
}

function pricedMini() {
  const looked = lookupModel("openai/gpt-4o-mini");
  if (!looked.ok) {
    throw new Error("gpt-4o-mini must stay priced");
  }
  return looked.price;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function failIfSlow<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 5_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function looksLikeSse(contentType: string | null, text: string): boolean {
  const type = (contentType ?? "").toLowerCase();
  return type.includes("text/event-stream") || text.startsWith("data:") || text.includes("\ndata:");
}

async function readRows(): Promise<{ id: string; amount: number; status: string; settled: number | null }[]> {
  return runInDurableObject(ledgerStub(), async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ id: string; amount_cents: number; status: string; settled_cents: number | null }>(
        `SELECT id, amount_cents, status, settled_cents FROM reservations`,
      )
      .toArray();
    return rows.map((row) => ({
      id: String(row.id),
      amount: Number(row.amount_cents),
      status: String(row.status),
      settled: row.settled_cents === null ? null : Number(row.settled_cents),
    }));
  });
}

function eventStream(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("sse streaming", () => {
  it("refuses a stream over the cap with no fetch and no stream bytes", async () => {
    const filled = await ledgerStub().reserve(10, "fill-the-cap");
    expect(filled.ok).toBe(true);
    const before = await ledgerStub().status();
    const beforeAudit = await audit(before.periodKey);
    const guarded = await failIfSlow(
      withUpstreamSpy(async () => {
        const response = await postJson(
          "/v1/chat/completions",
          chatBody({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        );
        const text = await response.text();
        return { response, text };
      }, () => eventStream(`${sse({ id: "should-not-stream" })}data: [DONE]\n\n`)),
      "stream over the limit still started a fetch or delivered stream bytes",
    );
    const after = await ledgerStub().status();
    const afterAudit = await audit(after.periodKey);
    let body: { ok?: boolean; error?: string } = {};
    try {
      body = JSON.parse(guarded.result.text) as { ok?: boolean; error?: string };
    } catch {
      body = {};
    }
    const contentType = guarded.result.response.headers.get("content-type");
    if (
      guarded.upstreamCalls !== 0 ||
      guarded.result.response.status !== 402 ||
      looksLikeSse(contentType, guarded.result.text) ||
      body.ok === true ||
      body.error !== "cap_exceeded" ||
      after.committedCents !== before.committedCents ||
      afterAudit.rows !== beforeAudit.rows ||
      afterAudit.committed !== beforeAudit.committed
    ) {
      throw new Error(
        `stream over the limit still started a fetch or delivered stream bytes: status=${guarded.result.response.status} contentType=${String(contentType)} upstreamCalls=${guarded.upstreamCalls} error=${String(body.error)} bytes=${JSON.stringify(guarded.result.text.slice(0, 120))} rows=${afterAudit.rows} committed=${after.committedCents}`,
      );
    }
    expect(after.committedCents).toBe(after.capCents);
    expect(afterAudit).toMatchObject({ committed: 10, held: 10, rows: 1 });
  });

  it("passes the first byte through on one fetch and bills the last usage chunk", async () => {
    if (env.OPENROUTER_API_KEY !== FIXTURE_OPENROUTER_KEY) {
      throw new Error("OPENROUTER_API_KEY binding is not the test fixture");
    }
    if (env.GATE_TOKEN !== FIXTURE_GATE_TOKEN) {
      throw new Error("GATE_TOKEN binding is not the test fixture");
    }
    const price = pricedMini();
    const earlyUsage = { prompt_tokens: 0, completion_tokens: 0 };
    const finalUsage = { prompt_tokens: 0, completion_tokens: 1 };
    const clientUsage = { prompt_tokens: 0, completion_tokens: 5_000_000 };
    const earlyQuote = quoteUsage(price, earlyUsage);
    const finalQuote = quoteUsage(price, finalUsage);
    const clientQuote = quoteUsage(price, clientUsage);
    const hold = estimateCallCents(price, MESSAGES, 1);
    if (
      earlyQuote !== 0 ||
      finalQuote === "missing_usage" ||
      clientQuote === "missing_usage" ||
      typeof finalQuote !== "number" ||
      finalQuote <= 0 ||
      finalQuote >= hold ||
      clientQuote <= hold
    ) {
      throw new Error(
        `fixture usage does not separate the stream bills: early=${String(earlyQuote)} final=${String(finalQuote)} client=${String(clientQuote)} hold=${hold}`,
      );
    }
    const full =
      sse({ id: "chunk-1", choices: [{ delta: { content: "H" } }], usage: earlyUsage }) +
      sse({ id: "chunk-2", choices: [{ delta: {}, finish_reason: "stop" }], usage: finalUsage }) +
      "data: [DONE]\n\n";
    const marker = JSON.stringify(finalUsage);
    const splitAt = full.lastIndexOf(marker);
    if (splitAt <= 0) {
      throw new Error("final usage chunk was not split");
    }
    const encoder = new TextEncoder();
    const head = encoder.encode(full.slice(0, splitAt));
    const tail = encoder.encode(full.slice(splitAt));
    let releaseRest = false;
    let reservedBeforeFetch = false;
    const guarded = await (async () => {
      try {
        return await withUpstreamSpy(
          async () => {
            const response = await failIfSlow(
              postJson(
                "/v1/chat/completions",
                chatBody({
                  usage: clientUsage,
                  api_key: CLIENT_SUPPLIED_KEY,
                  apiKey: CLIENT_SUPPLIED_KEY,
                }),
              ),
              "caller did not see the first byte",
            );
            if (!response.body) {
              throw new Error("caller did not see the first byte");
            }
            const reader = response.body.getReader();
            const first = await failIfSlow(reader.read(), "caller did not see the first byte");
            if (first.done || !first.value || first.value.byteLength === 0) {
              throw new Error("caller did not see the first byte");
            }
            const firstBytes = first.value;
            const firstText = new TextDecoder().decode(firstBytes);
            releaseRest = true;
            const merged = await failIfSlow(
              (async () => {
                const parts = [firstBytes];
                while (true) {
                  const next = await reader.read();
                  if (next.done) {
                    break;
                  }
                  if (next.value && next.value.byteLength > 0) {
                    parts.push(next.value);
                  }
                }
                const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
                let offset = 0;
                for (const part of parts) {
                  bytes.set(part, offset);
                  offset += part.byteLength;
                }
                return bytes;
              })(),
              "caller did not see the first byte",
            );
            return {
              status: response.status,
              contentType: response.headers.get("content-type"),
              firstText,
              text: new TextDecoder().decode(merged),
            };
          },
          async () => {
            const snapshot = await ledgerStub().status();
            reservedBeforeFetch = snapshot.committedCents === hold;
            return new Response(
              new ReadableStream<Uint8Array>({
                async start(controller) {
                  controller.enqueue(head);
                  while (!releaseRest) {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                  }
                  controller.enqueue(tail);
                  controller.close();
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          },
        );
      } finally {
        releaseRest = true;
      }
    })();
    const call = guarded.calls[0];
    const authorization = call?.authorization ?? null;
    const forwarded = call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : null;
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      !reservedBeforeFetch ||
      guarded.result.status !== 200 ||
      guarded.result.contentType !== "text/event-stream" ||
      guarded.result.firstText.length === 0 ||
      !full.startsWith(guarded.result.firstText) ||
      guarded.result.firstText.includes(marker) ||
      guarded.result.firstText.includes("reservationId") ||
      guarded.result.text !== full ||
      guarded.result.text.includes("reservationId") ||
      guarded.result.text.includes("committedCents") ||
      authorization !== `Bearer ${FIXTURE_OPENROUTER_KEY}` ||
      call?.url !== OPENROUTER_CHAT_COMPLETIONS_URL ||
      call?.method !== "POST" ||
      forwarded?.stream !== true ||
      forwarded?.usage !== undefined ||
      call?.body?.includes(CLIENT_SUPPLIED_KEY) ||
      call?.body?.includes(FIXTURE_OPENROUTER_KEY) ||
      call?.body?.includes(FIXTURE_GATE_TOKEN) ||
      !row ||
      row.status !== "settled" ||
      row.settled !== finalQuote ||
      status.committedCents !== finalQuote
    ) {
      throw new Error(
        `stream under the limit was not one fetched pass-through billed from the final chunk: upstreamCalls=${guarded.upstreamCalls} reservedBeforeFetch=${String(reservedBeforeFetch)} firstByte=${JSON.stringify(guarded.result.firstText.slice(0, 24))} settled=${String(row?.settled)} finalQuote=${String(finalQuote)} committed=${status.committedCents} authorizationIsFixture=${String(authorization === `Bearer ${FIXTURE_OPENROUTER_KEY}`)}`,
      );
    }
    expect(row.amount).toBe(hold);
    expect(row.settled).toBeLessThan(row.amount);
  });


  it("charges the full hold when the last stream chunk has no usage", async () => {
    const price = pricedMini();
    const earlyUsage = { prompt_tokens: 0, completion_tokens: 1 };
    const earlyQuote = quoteUsage(price, earlyUsage);
    const hold = estimateCallCents(price, MESSAGES, 1);
    if (earlyQuote === "missing_usage" || earlyQuote <= 0 || earlyQuote >= hold) {
      throw new Error(`fixture early usage must be a positive quote under the hold: early=${String(earlyQuote)} hold=${hold}`);
    }
    const payload =
      sse({ id: "early", usage: earlyUsage }) +
      sse({ id: "late", choices: [{ finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";
    const guarded = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody({ usage: { prompt_tokens: 0, completion_tokens: 0 } }));
      const text = await response.text();
      return { response, text };
    }, () => eventStream(payload));
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      guarded.result.text !== payload ||
      guarded.result.text.includes("reservationId") ||
      !row ||
      row.status !== "settled" ||
      row.settled === null ||
      row.settled === 0 ||
      row.settled === earlyQuote ||
      row.settled !== row.amount ||
      status.committedCents !== row.amount
    ) {
      throw new Error(
        `missing final usage was not charged at the hold: upstreamCalls=${guarded.upstreamCalls} settled=${String(row?.settled)} amount=${String(row?.amount)} earlyQuote=${String(earlyQuote)} committed=${status.committedCents}`,
      );
    }
    expect(row.status).not.toBe("released");
    const released = await ledgerStub().release(row.id);
    expect(released).toMatchObject({ ok: false, error: "not_held" });
  });

  it("keeps the hold when the last chunk exceeds it and does not fetch again", async () => {
    const price = pricedMini();
    const lateUsage = { prompt_tokens: 0, completion_tokens: 5_000_000 };
    const quoted = quoteUsage(price, lateUsage);
    const hold = estimateCallCents(price, MESSAGES, 1);
    if (quoted === "missing_usage" || quoted <= hold) {
      throw new Error("fixture usage must exceed the pessimistic hold");
    }
    const payload =
      sse({ id: "early", usage: { prompt_tokens: 0, completion_tokens: 0 } }) +
      sse({ id: "late", usage: lateUsage }) +
      "data: [DONE]\n\n";
    let fetches = 0;
    const guarded = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      const text = await response.text();
      return { response, text };
    }, () => {
      fetches += 1;
      return eventStream(payload);
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      fetches !== 1 ||
      guarded.result.text !== payload ||
      guarded.result.text.includes("exceeds_hold") ||
      guarded.result.text.includes("reservationId") ||
      !row ||
      row.status !== "held" ||
      row.settled !== null ||
      row.amount !== hold ||
      status.committedCents !== hold ||
      status.committedCents > status.capCents
    ) {
      throw new Error(
        `stream usage above the hold was not left in place: upstreamCalls=${guarded.upstreamCalls} fetches=${fetches} rowStatus=${String(row?.status)} settled=${String(row?.settled)} committed=${status.committedCents}`,
      );
    }
    const again = await ledgerStub().settle(row.id, quoted);
    const after = await ledgerStub().status();
    if (again.ok || again.error !== "exceeds_hold" || after.committedCents !== hold) {
      throw new Error(
        `hold did not stay exceeds_hold: ok=${String(again.ok)} error=${String(again.ok ? "" : again.error)} committed=${after.committedCents}`,
      );
    }
  });

  it("charges the hold once when the stream fetch throws", async () => {
    const guarded = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody());
      const text = await response.text();
      return { response, text };
    }, () => {
      throw new Error("socket closed");
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      guarded.result.response.status !== 502 ||
      looksLikeSse(guarded.result.response.headers.get("content-type"), guarded.result.text) ||
      !row ||
      row.status !== "settled" ||
      row.settled !== row.amount ||
      row.settled === 0 ||
      status.committedCents !== row.amount
    ) {
      throw new Error(
        `thrown stream fetch was not charged once: upstreamCalls=${guarded.upstreamCalls} http=${guarded.result.response.status} settled=${String(row?.settled)} amount=${String(row?.amount)} committed=${status.committedCents}`,
      );
    }
    expect(JSON.parse(guarded.result.text)).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(guarded.result.text).not.toContain(FIXTURE_OPENROUTER_KEY);
    expect(await ledgerStub().release(row.id)).toMatchObject({ ok: false, error: "not_held" });
  });

  it("charges the hold once when the upstream stream errors", async () => {
    const price = pricedMini();
    const partialUsage = { prompt_tokens: 0, completion_tokens: 0 };
    const partialQuote = quoteUsage(price, partialUsage);
    if (partialQuote !== 0) {
      throw new Error("partial usage must quote to 0 so a wrong bill is visible");
    }
    const encoder = new TextEncoder();
    let sent = false;
    const guarded = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody());
      if (!response.body) {
        throw new Error("stream error was swallowed");
      }
      const reader = response.body.getReader();
      void reader.closed.catch(() => undefined);
      let errored = false;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            break;
          }
        }
      } catch {
        errored = true;
      }
      return { response, errored };
    }, () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode(sse({ id: "partial", usage: partialUsage })));
              return;
            }
            throw new Error("socket closed");
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      !guarded.result.errored ||
      !row ||
      row.status !== "settled" ||
      row.settled !== row.amount ||
      row.settled === partialQuote ||
      row.settled === 0 ||
      status.committedCents !== row.amount
    ) {
      throw new Error(
        `errored stream was not charged once at the hold: upstreamCalls=${guarded.upstreamCalls} errored=${String(guarded.result.errored)} settled=${String(row?.settled)} amount=${String(row?.amount)} committed=${status.committedCents}`,
      );
    }
    expect(await ledgerStub().release(row.id)).toMatchObject({ ok: false, error: "not_held" });
  });

  it("settles explicit zero usage on the last chunk as zero cents", async () => {
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const quoted = quoteUsage(pricedMini(), usage);
    if (quoted !== 0) {
      throw new Error("zero token usage must quote to 0 cents");
    }
    const payload = sse({ id: "zero", usage }) + "data: [DONE]\n\n";
    const guarded = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody());
      const text = await response.text();
      return { response, text };
    }, () => eventStream(payload));
    const rows = await readRows();
    const status = await ledgerStub().status();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      guarded.result.text !== payload ||
      !row ||
      row.status !== "settled" ||
      row.settled !== 0 ||
      status.committedCents !== 0
    ) {
      throw new Error(
        `explicit zero stream usage was not settled to 0: upstreamCalls=${guarded.upstreamCalls} settled=${String(row?.settled)} committed=${status.committedCents}`,
      );
    }
    expect(row.amount).toBeGreaterThan(0);
  });

  it("does not fetch again when the same stream request id is retried", async () => {
    const payload = sse({ id: "once", usage: { prompt_tokens: 8, completion_tokens: 4 } }) + "data: [DONE]\n\n";
    const headers = { [REQUEST_ID_HEADER]: "stream-one-attempt" };
    const first = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody(), headers);
      const text = await response.text();
      return { response, text };
    }, () => eventStream(payload));
    const second = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody(), headers);
      const text = await response.text();
      return { response, text };
    }, () => eventStream(sse({ id: "twice" })));
    const rows = await readRows();
    if (first.upstreamCalls !== 1 || second.upstreamCalls !== 0 || rows.length !== 1 || second.result.text.includes("data:")) {
      throw new Error(
        `stream retry fetched again or reserved again: first=${first.upstreamCalls} second=${second.upstreamCalls} rows=${rows.length}`,
      );
    }
    expect(second.result.response.status).toBe(409);
    expect(JSON.parse(second.result.text)).toEqual({ ok: false, error: "idempotency_replay" });
    expect(first.result.text).toBe(payload);
  });

  it("does not fetch a stream for an unknown model or a missing price", async () => {
    const unknown = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody({ model: "no-such-model" }));
      const text = await response.text();
      return { response, text };
    });
    const unpriced = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody({ model: "fixture/unpriced" }));
      const text = await response.text();
      return { response, text };
    });
    const status = await ledgerStub().status();
    const stored = await audit(status.periodKey);
    if (
      unknown.upstreamCalls !== 0 ||
      unpriced.upstreamCalls !== 0 ||
      looksLikeSse(unknown.result.response.headers.get("content-type"), unknown.result.text) ||
      looksLikeSse(unpriced.result.response.headers.get("content-type"), unpriced.result.text) ||
      stored.rows !== 0 ||
      status.committedCents !== 0
    ) {
      throw new Error(
        `unpriced stream reached upstream or the ledger: unknownCalls=${unknown.upstreamCalls} unpricedCalls=${unpriced.upstreamCalls} rows=${stored.rows} committed=${status.committedCents}`,
      );
    }
    expect(unknown.result.response.status).toBe(402);
    expect(JSON.parse(unknown.result.text)).toMatchObject({ ok: false, error: "unknown_model" });
    expect(unpriced.result.response.status).toBe(402);
    expect(JSON.parse(unpriced.result.text)).toMatchObject({ ok: false, error: "missing_price" });
  });

  it("keeps the non-stream bill when stream is false", async () => {
    const usage = { prompt_tokens: 0, completion_tokens: 1 };
    const quoted = quoteUsage(pricedMini(), usage);
    const hold = estimateCallCents(pricedMini(), MESSAGES, 1);
    if (quoted === "missing_usage" || quoted <= 0 || quoted >= hold) {
      throw new Error("fixture usage must sit under the hold");
    }
    const payload = { id: "gen_plain", choices: [{ message: { role: "assistant", content: "ok" } }], usage };
    const guarded = await withUpstreamSpy(async () => {
      const response = await postJson("/v1/chat/completions", chatBody({ stream: false, usage: { prompt_tokens: 0, completion_tokens: 5_000_000 } }));
      const text = await response.text();
      return { response, text };
    }, () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    const rows = await readRows();
    const row = rows[0];
    if (
      guarded.upstreamCalls !== 1 ||
      guarded.result.response.headers.get("content-type") !== "application/json" ||
      guarded.result.text !== JSON.stringify(payload) ||
      !row ||
      row.status !== "settled" ||
      row.settled !== quoted
    ) {
      throw new Error(
        `non-stream path changed: upstreamCalls=${guarded.upstreamCalls} settled=${String(row?.settled)} quoted=${String(quoted)}`,
      );
    }
  });
});
