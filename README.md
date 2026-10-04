# Caplatch

Deploy this template on your own Cloudflare account; INGENIUMOWL e.U. does not host Caplatch and does not hold your keys.

M1b is the fail-closed latch on the M1a ledger. One Cloudflare Worker exposes one SQLite Durable Object, `SpendLedger`, with `reserve`, `settle`, and `release`. The cap is an integer number of cents (`CAP_CENTS`). The window is the UTC calendar month, or lifetime when `PERIOD` is `lifetime` (or `none`). `X-Caplatch-Request-Id` (or `requestId`) is remembered for one hour so the same id does not reserve twice.

`POST /v1/chat/completions` checks the model, the price row, and the ledger before any upstream call. This slice does not forward to OpenRouter. An unknown model, a missing price, or a ledger throw responds with failure and does not call upstream. Missing usage keeps the pessimistic hold and is not settled as zero. `settle` rejects an actual amount above that hold, so committed cents stay within the hold and the cap.

Cloudflare AI Gateway spend limits are eventually consistent, so a burst can pass the cap; this ledger holds inside one Durable Object transaction.

The default cap in `wrangler.toml` is `1000` cents. Vars are not secrets. Do not put keys or tokens in git.

## Run the tests

```sh
npm install
npm test
```

`npm test` is the proof. It sends 50 concurrent reserves of 1 cent against a cap of 10 cents (the Vitest config sets `CAP_CENTS` to `10`; the template default stays `1000`). The sum of successful holds is 10, and the other 40 fail with `cap_exceeded`. It also runs the fail-closed cases: ledger throw, unknown model, missing price, and missing usage. Those fail the run if the Worker reports success or if `fetch` reaches OpenRouter. The settle check fails if a settle above the hold raises `committedCents` over the cap or over the prior hold.

## License

Proprietary. Copyright INGENIUMOWL e.U. All rights reserved. See `LICENSE`.
