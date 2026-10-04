import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { LEDGER_NAME } from "../src/constants";
import { FIXTURE_GATE_TOKEN } from "./fixture";

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

function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

export async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const gate = hasAuthorization(headers) ? {} : { authorization: `Bearer ${FIXTURE_GATE_TOKEN}` };
  return exports.default.fetch(
    new Request(`https://caplatch.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gate,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

export type UpstreamCall = {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
};

export type UpstreamResponder = (call: UpstreamCall) => Response | Promise<Response>;

function headerValue(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null {
  if (init?.headers) {
    return new Headers(init.headers).get(name);
  }
  if (input instanceof Request) {
    return input.headers.get(name);
  }
  return null;
}

function bodyText(init: RequestInit | undefined): string | null {
  if (typeof init?.body === "string") {
    return init.body;
  }
  return null;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (typeof init?.method === "string") {
    return init.method;
  }
  if (input instanceof Request) {
    return input.method;
  }
  return "GET";
}

export async function withUpstreamSpy<T>(
  run: () => Promise<T>,
  respond?: UpstreamResponder,
): Promise<{ result: T; upstreamCalls: number; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (isUpstreamUrl(url)) {
      const call: UpstreamCall = {
        url,
        method: methodOf(input, init),
        authorization: headerValue(input, init, "authorization"),
        body: bodyText(init),
      };
      calls.push(call);
      if (respond) {
        return respond(call);
      }
      return new Response(JSON.stringify({ ok: true, error: "upstream_called" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, upstreamCalls: calls.length, calls };
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
