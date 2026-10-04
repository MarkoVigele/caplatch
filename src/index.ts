import { LEDGER_NAME, REQUEST_ID_HEADER } from "./constants";
import { isRequestId } from "./input";

export { SpendLedger } from "./ledger";

type ErrorCode =
  | "invalid_json"
  | "invalid_amount"
  | "invalid_request_id"
  | "invalid_reservation_id"
  | "request_id_mismatch"
  | "method_not_allowed";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function fail(error: ErrorCode, status: number): Response {
  return json({ ok: false, error }, status);
}

function httpStatus(result: { ok: boolean; error?: string }): number {
  if (result.ok) {
    return 200;
  }
  switch (result.error) {
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

type ResolvedId = string | null | "invalid" | "absent";

function normalizeId(value: unknown): ResolvedId {
  if (typeof value !== "string") {
    return "invalid";
  }
  const trimmed = value.trim();
  if (!isRequestId(trimmed)) {
    return "invalid";
  }
  return trimmed;
}

function bodyRequestId(body: Record<string, unknown>): ResolvedId {
  if (!Object.prototype.hasOwnProperty.call(body, "requestId") || body.requestId === null) {
    return "absent";
  }
  return normalizeId(body.requestId);
}

function headerRequestId(request: Request): ResolvedId {
  if (!request.headers.has(REQUEST_ID_HEADER)) {
    return "absent";
  }
  return normalizeId(request.headers.get(REQUEST_ID_HEADER));
}

function resolveRequestId(body: Record<string, unknown>, request: Request): string | null | Response {
  const fromBody = bodyRequestId(body);
  const fromHeader = headerRequestId(request);
  if (fromBody === "invalid" || fromHeader === "invalid") {
    return fail("invalid_request_id", 400);
  }
  if (fromBody !== "absent" && fromHeader !== "absent" && fromBody !== fromHeader) {
    return fail("request_id_mismatch", 400);
  }
  if (fromHeader !== "absent") {
    return fromHeader;
  }
  if (fromBody !== "absent") {
    return fromBody;
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return fail("invalid_json", 400);
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return fail("invalid_json", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("invalid_json", 400);
  }
  return parsed as Record<string, unknown>;
}

function ledger(env: Cloudflare.Env) {
  return env.LEDGER.getByName(LEDGER_NAME);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const stub = ledger(env);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        return json({ name: "caplatch", slice: "M1a" }, 200);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return json(await stub.status(), 200);
      }
      if (url.pathname === "/reserve") {
        if (request.method !== "POST") {
          return fail("method_not_allowed", 405);
        }
        const body = await readJson(request);
        if (body instanceof Response) {
          return body;
        }
        if (typeof body.amountCents !== "number") {
          return fail("invalid_amount", 400);
        }
        const requestId = resolveRequestId(body, request);
        if (requestId instanceof Response) {
          return requestId;
        }
        const result = await stub.reserve(body.amountCents, requestId);
        return json(result, httpStatus(result));
      }
      if (url.pathname === "/settle") {
        if (request.method !== "POST") {
          return fail("method_not_allowed", 405);
        }
        const body = await readJson(request);
        if (body instanceof Response) {
          return body;
        }
        if (typeof body.reservationId !== "string") {
          return fail("invalid_reservation_id", 400);
        }
        if (typeof body.actualCents !== "number") {
          return fail("invalid_amount", 400);
        }
        const result = await stub.settle(body.reservationId, body.actualCents);
        return json(result, httpStatus(result));
      }
      if (url.pathname === "/release") {
        if (request.method !== "POST") {
          return fail("method_not_allowed", 405);
        }
        const body = await readJson(request);
        if (body instanceof Response) {
          return body;
        }
        if (typeof body.reservationId !== "string") {
          return fail("invalid_reservation_id", 400);
        }
        const result = await stub.release(body.reservationId);
        return json(result, httpStatus(result));
      }
      return json({ ok: false, error: "not_found" }, 404);
    } catch {
      return json({ ok: false, error: "ledger_unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
