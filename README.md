# Caplatch

Deploy this template on your own Cloudflare account; INGENIUMOWL e.U. does not host Caplatch and does not hold your keys.

M1a is the spend ledger only. One Cloudflare Worker exposes one SQLite Durable Object, `SpendLedger`, with `reserve`, `settle`, and `release`. The cap is an integer number of cents (`CAP_CENTS`). The window is the UTC calendar month, or lifetime when `PERIOD` is `lifetime` (or `none`). `X-Caplatch-Request-Id` (or `requestId`) is remembered for one hour so the same id does not reserve twice.

Unknown-model fail-closed behavior and the OpenRouter proxy are out of this slice (M1b+).

Cloudflare AI Gateway spend limits are eventually consistent, so a burst can pass the cap; this ledger holds inside one Durable Object transaction.

The default cap in `wrangler.toml` is `1000` cents. Vars are not secrets. Do not put keys or tokens in git.

## Run the tests

```sh
npm install
npm test
```

`npm test` is the M1a proof. It sends 50 concurrent reserves of 1 cent against a cap of 10 cents (the Vitest config sets `CAP_CENTS` to `10`; the template default stays `1000`). The sum of successful holds is 10, and the other 40 fail with `cap_exceeded`.

## License

Proprietary. Copyright INGENIUMOWL e.U. All rights reserved. See `LICENSE`.
