import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { LEDGER_NAME } from "../src/constants";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function isUpstreamUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("https://openrouter.ai/") || lower.startsWith("http://openrouter.ai/");
}

export function ledgerStub() {
  return env.LEDGER.getByName(LEDGER_NAME);
}

export async function clearLedger(): Promise<void> {
  await runInDurableObject(ledgerStub(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM idempotency");
    state.storage.sql.exec("DELETE FROM reservations");
  });
}

export async function getJson(path: string): Promise<Response> {
  return exports.default.fetch(new Request(`https://caplatch.test${path}`));
}

export async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://caplatch.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

export async function withUpstreamSpy<T>(
  run: () => Promise<T>,
): Promise<{ result: T; upstreamCalls: number }> {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (isUpstreamUrl(url)) {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true, error: "upstream_called" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, upstreamCalls: seen.length };
  } finally {
    globalThis.fetch = real;
  }
}

export async function audit(
  periodKey: string,
): Promise<{ committed: number; held: number; rows: number }> {
  return runInDurableObject(ledgerStub(), async (_instance, state) => {
    const row = state.storage.sql
      .exec<{ committed: number; held: number; rows: number }>(
        `SELECT
           COALESCE(SUM(
             CASE status
               WHEN 'held' THEN amount_cents
               WHEN 'settled' THEN COALESCE(settled_cents, 0)
               ELSE 0
             END
           ), 0) AS committed,
           COALESCE(SUM(CASE WHEN status = 'held' THEN amount_cents ELSE 0 END), 0) AS held,
           COUNT(*) AS rows
         FROM reservations
         WHERE period_key = ?`,
        periodKey,
      )
      .one();
    return {
      committed: Number(row.committed),
      held: Number(row.held),
      rows: Number(row.rows),
    };
  });
}
