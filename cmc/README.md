# cmc — one stock, many wrappers, ranked by what $100 actually buys

Part of the CoinMarketCap API hackathon entry (RWA track). Give it a stock ticker such as `NVDA` and it:

1. reads the stock's tokenized wrappers from CoinMarketCap's RWA API (`/v5/real-world-assets/quotes/latest`): each token, its issuer and its CMC price;
2. expands each token to the chains it lives on (`/v2/cryptocurrency/info`, `contract_address[]`), so a wrapper is one token on one chain;
3. asks LI.FI's public quote API how many tokens $100 of USDC on that chain really buys, and what gas the route costs;
4. ranks the wrappers by received value and marks the top one "receives the most".

A wrapper that trades below the stock can still lose once you pay to get into it. That is why the ranking uses route cost, not the price gap alone.

## The numbers

For each wrapper, with `ref` = the reference price of the stock and `p` = the wrapper's CMC price:

| Field | Formula |
| --- | --- |
| premium | `(p / ref - 1) * 100` |
| route cost | `$100 - tokensOut * p + gas` (DEX fees and price impact, plus gas) |
| receives | `tokensOut * ref - gas` (the stock exposure you hold, net of gas) |

`ref` defaults to CMC's `average_tokenized_price` for the asset, because the RWA endpoints do not return the exchange-listed stock price. Pass `referencePriceUsd` to use another one. One token is taken as one share.

Wrappers on chains without a route are kept and listed last, with the reason: `non_evm_chain` (Solana, TON), `unsupported_chain` (EVM, but no quote source wired yet) or `no_route` (the quote API had no route).

## Use

Node 24 runs the TypeScript directly; there are no dependencies.

```bash
pnpm test                                   # fixtures only, no network
CMC_PRO_API_KEY=... pnpm compare NVDA       # live: CoinMarketCap + LI.FI
node --env-file=<a file outside this repo> scripts/compare-live.ts NVDA --json out.json
```

The key is read only from the `CMC_PRO_API_KEY` environment variable and only sent as the `X-CMC_PRO_API_KEY` header. It is never stored in this repository.

```ts
import { compareWrappers, createCmcClient, createLifiQuoter } from "./src/index.ts";

const result = await compareWrappers({
  cmc: createCmcClient({ apiKey: process.env.CMC_PRO_API_KEY! }),
  quoter: createLifiQuoter(),
  symbol: "NVDA",
});
result.rows[0]; // the wrapper that receives the most
```

Nothing here signs or sends a transaction. Route quotes use a placeholder sender address; buying happens later, in DeSpell, after the user signs.

## Files

| File | What it does |
| --- | --- |
| `src/cmc.ts` | CoinMarketCap client and response types |
| `src/wrappers.ts` | token × chain grouping |
| `src/chains.ts` | CMC platform names to EVM chain ids; USDC per chain |
| `src/lifi.ts` | LI.FI route quotes |
| `src/rank.ts` | premium, route cost, received value, order |
| `src/compare.ts` | the whole flow in one call |
| `src/format.ts` | plain-text table |
| `test/fixtures/` | CMC and LI.FI responses recorded on 2026-11-25, trimmed to the fields read |
