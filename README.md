# Caplatch

Deploy this template on your own Cloudflare account; INGENIUMOWL e.U. does not host Caplatch and does not hold your keys.

## Install

1. Use a Cloudflare account you own.
2. From this directory, run `npx wrangler deploy`.
3. Run `wrangler secret put OPENROUTER_API_KEY` and `wrangler secret put GATE_TOKEN`. Do not put either value in `wrangler.toml`, in git, or in logs.
4. Then deliberately set `UPSTREAM_ENABLED` to `true` and set `CAP_CENTS` in `wrangler.toml`, and run `npx wrangler deploy` again so the Worker uses those vars. The file ships with `UPSTREAM_ENABLED` `"false"` and `CAP_CENTS` `"1000"`.
5. In the app, change only `baseURL` to the Worker and use `GATE_TOKEN` as the SDK key, not the OpenRouter key.

    import OpenAI from "openai";

    const client = new OpenAI({
      baseURL: "https://<your-worker>/v1",
      apiKey: process.env.GATE_TOKEN,
    });

`GET /` returns `{ "name": "caplatch", "slice": "M2c" }` and does not require a token.

Caplatch refuses before the call goes out, including when it cannot prove budget remains; AI Gateway can let a burst through.

The cent amount is an estimate from the table, not the OpenRouter invoice.

Using the OpenRouter key directly and bypassing the Worker is outside the latch.

## What it does

M2c checks `Authorization: Bearer` against the Worker secret `GATE_TOKEN` before a reservation and before any fetch, on `POST /v1/chat/completions` and on `/reserve`, `/settle`, and `/release`. A missing, empty, or wrong bearer is HTTP 401, with no reservation and no upstream call, including `stream: true`. `GET /` and `GET /status` stay open without a token. If `GATE_TOKEN` is not set, chat stays closed.

`POST /v1/chat/completions` is forwarded to OpenRouter only after that check and only after the ledger accepts a pessimistic reservation. The cap is an integer number of cents (`CAP_CENTS`). The window is the UTC calendar month, or lifetime when `PERIOD` is `lifetime` (or `none`). `X-Caplatch-Request-Id` (or `requestId`) is remembered for one hour so the same id does not reserve twice and does not call OpenRouter twice.

The repo prices exactly two models: `openai/gpt-4o-mini` at 15 cents in and 60 cents out per million tokens, and `openai/gpt-4o` at 250 cents in and 1000 cents out per million tokens. A model that is not one of those two is `unknown_model` and is refused with no reservation and no upstream call. Prices stay in the repo. The request path does not fetch them.

`CURRENCY` missing or `usd` leaves the cap at `CAP_CENTS` US cents. `CURRENCY` `eur` treats `CAP_CENTS` as euro-cents and converts them with the fixed constant 110 US cents per euro, so 100 euro-cents is a cap of 110 US cents. That rate is not a live FX quote, and the conversion does not fetch. Any other currency refuses the chat call before a reservation and before a fetch.

The chat path checks the gate, then the currency, then the model and the price row. An unsupported currency, an unknown model, or a missing price is refused with no reservation and no upstream call. A reservation that does not fit the cap is refused with no upstream call. A refused stream returns that JSON error and no stream bytes. After a new hold, the Worker makes one `fetch` to `https://openrouter.ai/api/v1/chat/completions`. The reserve is in place before that request starts. `usage` on the client request is ignored. A non-stream bill is the OpenRouter response `usage`. A `stream: true` bill is the `usage` on the last SSE chunk, and those SSE bytes are passed through to the caller. If that `usage` is missing, the full hold is settled and is not released. If that quote is above the hold, the ledger returns `exceeds_hold`, the hold stays, and there is no second fetch. If the upstream fetch or the stream throws, the full hold is settled once. The caller receives the OpenRouter status and body, not the ledger receipt.

The upstream key is the Worker secret `OPENROUTER_API_KEY` only. The app sends `GATE_TOKEN` and never the OpenRouter key. Do not put either value in `wrangler.toml`, in git, in the request body, or in logs. `UPSTREAM_ENABLED` defaults to `"false"`, so a deploy does not call OpenRouter until you set that var to `"true"` and put both secrets in place. There is no prompt log.

The default cap in `wrangler.toml` is `1000` cents. Vars are not secrets.

## Run the tests

```sh
npm install
npm test
```

`npm test` is the proof. It sends 50 concurrent reserves of 1 cent against a cap of 10 cents (the Vitest config sets `CAP_CENTS` to `10`; the template default stays `1000`). The sum of successful holds is 10, and the other 40 fail with `cap_exceeded`. The proxy proof throws if a full cap still calls OpenRouter or adds a reservation, if an under-cap chat does not make exactly one fetch with `Authorization: Bearer` set to the fixture `OPENROUTER_API_KEY` (and not a client-supplied key), or if an unknown model or a missing price still fetches. The stream proof throws if a stream over the cap starts a fetch or delivers stream bytes, if an under-cap stream is not exactly one fetch, if the caller does not see the first upstream byte, or if the bill is not the final usage chunk. The price proof throws if either named model has no price, if the table lists any other model, or if an unknown model is reserved or fetched. The euro proof throws if 100 euro-cents is not a cap of 110 US cents, or if that conversion fetches. The gate proof throws if a chat without a token or with the wrong token fetches or reserves, if `wrangler.toml` contains a secret value, or if the difference sentence is missing. A mocked fetch stands in for the network.

## License

Proprietary. Copyright INGENIUMOWL e.U. All rights reserved. See `LICENSE`.
