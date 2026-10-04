# Caplatch

Deploy this template on your own Cloudflare account; INGENIUMOWL e.U. does not host Caplatch and does not hold your keys.

M1c forwards one non-streaming `POST /v1/chat/completions` to OpenRouter only after the ledger accepts a pessimistic reservation. The cap is an integer number of cents (`CAP_CENTS`). The window is the UTC calendar month, or lifetime when `PERIOD` is `lifetime` (or `none`). `X-Caplatch-Request-Id` (or `requestId`) is remembered for one hour so the same id does not reserve twice and does not call OpenRouter twice.

The chat path checks the model and the price row first. An unknown model or a missing price is refused with no reservation and no upstream call. A reservation that does not fit the cap is refused with no upstream call. After a new hold, the Worker makes one `fetch` to `https://openrouter.ai/api/v1/chat/completions`. `usage` on the client request is ignored. The bill is the OpenRouter response `usage`. If that `usage` is missing, the full hold is settled and is not released. If that quote is above the hold, the ledger returns `exceeds_hold`, the hold stays, and there is no second fetch. The caller receives the OpenRouter status and body, not the ledger receipt.

The upstream key is the Worker secret `OPENROUTER_API_KEY` only. Do not put it in `wrangler.toml`, in git, in the request, or in logs. `UPSTREAM_ENABLED` defaults to `"false"`, so a deploy does not call OpenRouter until you set that var to `"true"` and put the secret in place. Streaming is refused. There is no prompt log.

Cloudflare AI Gateway spend limits are eventually consistent, so a burst can pass the cap; this ledger holds inside one Durable Object transaction.

The default cap in `wrangler.toml` is `1000` cents. Vars are not secrets.

## Run the tests

```sh
npm install
npm test
```

`npm test` is the proof. It sends 50 concurrent reserves of 1 cent against a cap of 10 cents (the Vitest config sets `CAP_CENTS` to `10`; the template default stays `1000`). The sum of successful holds is 10, and the other 40 fail with `cap_exceeded`. The proxy proof throws if a full cap still calls OpenRouter or adds a reservation, if an under-cap chat does not make exactly one fetch with `Authorization: Bearer` set to the fixture `OPENROUTER_API_KEY` (and not a client-supplied key), or if an unknown model or a missing price still fetches. A mocked fetch stands in for the network.

## License

Proprietary. Copyright INGENIUMOWL e.U. All rights reserved. See `LICENSE`.
