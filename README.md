# Caplatch

Deploy this template on your own Cloudflare account; INGENIUMOWL e.U. does not host Caplatch and does not hold your keys.

M2b forwards `POST /v1/chat/completions` to OpenRouter only after the ledger accepts a pessimistic reservation. The cap is an integer number of cents (`CAP_CENTS`). The window is the UTC calendar month, or lifetime when `PERIOD` is `lifetime` (or `none`). `X-Caplatch-Request-Id` (or `requestId`) is remembered for one hour so the same id does not reserve twice and does not call OpenRouter twice.

The repo prices exactly two models: `openai/gpt-4o-mini` at 15 cents in and 60 cents out per million tokens, and `openai/gpt-4o` at 250 cents in and 1000 cents out per million tokens. A model that is not one of those two is `unknown_model` and is refused with no reservation and no upstream call. Prices stay in the repo. The request path does not fetch them.

`CURRENCY` missing or `usd` leaves the cap at `CAP_CENTS` US cents. `CURRENCY` `eur` treats `CAP_CENTS` as euro-cents and converts them with the fixed constant 110 US cents per euro, so 100 euro-cents is a cap of 110 US cents. That rate is not a live FX quote, and the conversion does not fetch. Any other currency refuses the chat call before a reservation and before a fetch.

The chat path checks the currency, then the model and the price row. An unsupported currency, an unknown model, or a missing price is refused with no reservation and no upstream call. A reservation that does not fit the cap is refused with no upstream call. A refused stream returns that JSON error and no stream bytes. After a new hold, the Worker makes one `fetch` to `https://openrouter.ai/api/v1/chat/completions`. The reserve is in place before that request starts. `usage` on the client request is ignored. A non-stream bill is the OpenRouter response `usage`. A `stream: true` bill is the `usage` on the last SSE chunk, and those SSE bytes are passed through to the caller. If that `usage` is missing, the full hold is settled and is not released. If that quote is above the hold, the ledger returns `exceeds_hold`, the hold stays, and there is no second fetch. If the upstream fetch or the stream throws, the full hold is settled once. The caller receives the OpenRouter status and body, not the ledger receipt.

The upstream key is the Worker secret `OPENROUTER_API_KEY` only. Do not put it in `wrangler.toml`, in git, in the request, or in logs. `UPSTREAM_ENABLED` defaults to `"false"`, so a deploy does not call OpenRouter until you set that var to `"true"` and put the secret in place. There is no prompt log.

Cloudflare AI Gateway spend limits are eventually consistent, so a burst can pass the cap; this ledger holds inside one Durable Object transaction.

The default cap in `wrangler.toml` is `1000` cents. Vars are not secrets.

## Run the tests

```sh
npm install
npm test
```

`npm test` is the proof. It sends 50 concurrent reserves of 1 cent against a cap of 10 cents (the Vitest config sets `CAP_CENTS` to `10`; the template default stays `1000`). The sum of successful holds is 10, and the other 40 fail with `cap_exceeded`. The proxy proof throws if a full cap still calls OpenRouter or adds a reservation, if an under-cap chat does not make exactly one fetch with `Authorization: Bearer` set to the fixture `OPENROUTER_API_KEY` (and not a client-supplied key), or if an unknown model or a missing price still fetches. The stream proof throws if a stream over the cap starts a fetch or delivers stream bytes, if an under-cap stream is not exactly one fetch, if the caller does not see the first upstream byte, or if the bill is not the final usage chunk. The price proof throws if either named model has no price, if the table lists any other model, or if an unknown model is reserved or fetched. The euro proof throws if 100 euro-cents is not a cap of 110 US cents, or if that conversion fetches. A mocked fetch stands in for the network.

## License

Proprietary. Copyright INGENIUMOWL e.U. All rights reserved. See `LICENSE`.
