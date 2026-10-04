import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { LEDGER_NAME } from "../src/constants";

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
