# cmc — one stock, many wrappers, ranked by what $100 actually buys

Part of the CoinMarketCap API hackathon entry (RWA track). Give it a stock ticker such as `NVDA` and it:

1. reads the stock's tokenized wrappers from CoinMarketCap's RWA API (`/v5/real-world-assets/quotes/latest`): each token, its issuer and its CMC price;
2. expands each token to the chains it lives on (`/v2/cryptocurrency/info`, `contract_address[]`), so a wrapper is one token on one chain;
3. asks LI.FI's public quote API how many tokens $100 of USDC on that chain really buys, and what gas the route costs;
4. ranks the wrappers by received value and marks the top one "receives the most".

A wrapper that trades below the stock can still lose once you pay to get into it. That is why the ranking uses route cost, not the price gap alone.

## Quick start

You need Node 24 and pnpm 10 (`corepack enable` gives you the pinned pnpm), and a CoinMarketCap API key from [pro.coinmarketcap.com](https://pro.coinmarketcap.com). That key is the only one you need.

```bash
git clone https://github.com/DeSPELL-OFFICIAL/despell-router-lab.git
cd despell-router-lab
pnpm install --frozen-lockfile

# 1. The ranking in your terminal
cd cmc
CMC_PRO_API_KEY=<your key> pnpm compare NVDA

# 2. The same ranking as a page, with Buy links into DeSpell
cd ..
CMC_PRO_API_KEY=<your key> pnpm dev      # then open http://localhost:3000/cmc
```

The terminal run prints every NVIDIA wrapper CoinMarketCap lists (about 19 token-and-chain pairs), the reference price, when the prices and quotes were measured, and which wrapper receives the most for $100. Route quotes come from LI.FI's public API without a key; it allows a few dozen quotes an hour, and one run uses about 13. Set `LIFI_API_KEY` if you run it often.

Buy links on the page open DeSpell's production app: if you connect a wallet there and sign, you buy the real tokenized stock. Nothing moves until you sign in DeSpell.

## The numbers

For each wrapper, with `ref` = the reference price of the stock, and a quote that turns $100 into `tokensOut` with fees taken inside the route (`fees in`) and costs paid on top (`gas`, `fees on top`):

| Field | Formula |
| --- | --- |
| execution price | `($100 - fees in) / tokensOut`, the price this route pays per token |
| premium | `(execution price / ref - 1) * 100` |
| receives | `tokensOut * ref - (gas + fees on top)`, the stock exposure you hold |
| short | `$100 - receives`, always in ranking order |
| known cost | `gas + fees on top + fees in` |
| price gap | `short - known cost` = `tokensOut * (execution price - ref)`, negative when the route pays below `ref` |

`ref` defaults to CMC's `average_tokenized_price` for the asset, because the RWA endpoints do not return the exchange-listed stock price. Pass `referencePriceUsd` to use another one. One token is taken as one share. The wrapper's own CMC price is reported (`cmcPremiumPct`) but not used to rank: it can lag the price you would actually pay.

A route paying more than 3% away from `ref` (`maxPremiumPct`, 2 or 3 is sensible) is not ranked. Paying well below the stock is not a cheaper share: it is a token worth less than one share, a depeg, or a bad quote. Inside the band, a row paying more than 1% below the stock, or receiving more than it spent, is ranked but never marked best: if its token is not exactly one share, the discount is a loss. Rows within $0.05 of the best (`tieUsd`) are marked as tied. If any quote failed or came back without its cost fields, `incomplete` counts those rows and no row is marked best.

Rows that cannot be ranked are kept and listed last, with the reason:

| Reason | Meaning |
| --- | --- |
| `no_contract` | CMC lists the token but gives no contract address (or no info at all) |
| `non_evm_chain` | Solana, TON: no EVM route quote |
| `unsupported_chain` | EVM or unrecognised chain with no quote source wired yet |
| `no_route` | LI.FI answered 404: no route for this pair |
| `quote_failed` | rate limit (after one retry), server error or network drop; makes the ranking incomplete |
| `quote_incomplete` | gas or a fee without a valid, non-negative USD amount, or a fee that does not say whether it is included; makes the ranking incomplete |
| `premium_out_of_band` | the route pays more than `maxPremiumPct` away from the stock |

## Buying through DeSpell

The lab app's `/cmc` page shows this ranking with a [Buy] button per wrapper. The button asks DeSpell's public connector (MCP, `prepare_swap`) for a 15-minute link that opens the same trade, 100 USDC into that wrapper on its own chain, as a card in DeSpell. Whoever opens the link connects their own wallet there, sees the quote for that wallet, and signs or not. Nothing in this repository signs or moves funds.

- `src/despell.ts` asks `find_token` whether DeSpell can buy each ranked wrapper, and refuses any `prepare_swap` answer whose chain, token addresses or amount differ from the request, or whose link is not the connector's own site carrying only a handoff id.
- `src/view.ts` keeps "Receives the most" on the true best. If DeSpell cannot buy that wrapper, its [Buy] is disabled with the reason and the first buyable candidate is marked "Most you can buy on DeSpell". With no best (a quote failed, or everything at the top trades too far below the stock), no row gets a badge and the page says why.
- The connector defaults to the production app, `https://app.despell.io/api/mcp`: a link signed there buys the real tokenized stock. Set `DESPELL_MCP_URL=https://test.despell.io/api/mcp` for DeSpell's test deployment. The page names which one it uses.

| Variable | Needed | What for |
| --- | --- | --- |
| `CMC_PRO_API_KEY` | yes | CoinMarketCap RWA and cryptocurrency info |
| `LIFI_API_KEY` | no | LI.FI quotes above the keyless limit (a few dozen an hour; one page view uses about 13) |
| `DESPELL_MCP_URL` | no | DeSpell connector; production app by default |

The page reuses one measurement: 5 minutes when complete, 1 minute when only a DeSpell check failed, 5, 10, 20, then 30 minutes while quotes keep failing (usually LI.FI's rate limit), when the page says when it will measure next, and 1 minute after an error. The Buy action only accepts a row that this measured screen shows as buyable, fixes the amount on the server, and asks for at most 20 links a minute per server process.

## What we thought of the CoinMarketCap API

Built on the Pro API with the RWA endpoints, November 2026.

What worked well:

- `/v5/real-world-assets/quotes/latest` gives every tokenized wrapper of a stock in one call, each with its issuer, price, market cap and 24h volume. That is the whole starting list for this project, in one credit.
- `/v2/cryptocurrency/info` turns each token into its contract on every chain it is deployed on, so the jump from "a CMC token" to "something a wallet can buy" is one more call.
- The documentation is published as Markdown per endpoint with full response schemas, which made it quick to write typed clients and fixtures. The ID map endpoint costs no credits.
- The response envelope is the same everywhere (`data` plus `status` with `error_code`, `credit_count`), so one error path covers every call.

What we had to work around:

- The RWA quotes carry no exchange-listed price for the underlying stock, only the average of the tokenized prices. We use that average as the reference and say so on screen; a premium "against the stock" would be clearer with the real share price.
- RWA `tokens[]` has no chain or contract address, so a second call is needed. Chains then come as display names (`BNB Smart Chain (BEP20)`, `Robinhood Chain`) rather than chain ids, which we map by hand.
- `error_code` is a string (`"0"`) on the RWA endpoints and a number (`0`) on cryptocurrency info.
- The token list for NVIDIA includes a derivatives index entry with no contract and a market cap of 0, and some tokens have a null price. We keep both visible with a reason rather than drop them.
- It is not clear which tokens `average_tokenized_price` averages, or how: in our recorded response it matched neither the plain mean nor the market-cap or volume weighted mean of the listed token prices, with or without the derivatives entry.
- The keyless public API does not include the RWA endpoints, so even a quick look needs a key.

## Use

`cmc/` is a package of the root pnpm workspace (`@despell-lab/cmc`). Node 24 runs the TypeScript directly; there are no runtime dependencies. TypeScript is a dev dependency, only for type checking. The root `pnpm verify` runs this package's typecheck and tests with the rest.

```bash
# from the repository root
pnpm install --frozen-lockfile
pnpm --filter @despell-lab/cmc test        # fixtures only, no network
pnpm --filter @despell-lab/cmc typecheck

# live: CoinMarketCap + LI.FI (from cmc/)
CMC_PRO_API_KEY=... pnpm compare NVDA
node --env-file=<a file outside this repo> scripts/compare-live.ts NVDA --max-premium 2 --json out.json
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
| `src/rank.ts` | premium, received value, short split, band, best and ties |
| `src/compare.ts` | the whole flow in one call |
| `src/format.ts` | plain-text table |
| `src/despell.ts` | DeSpell connector: buyability and handoff links |
| `src/view.ts` | the list screen model: badges, buy states, folded rows |
| `src/screen.ts` | compare, check buyability, build the screen model |
| `test/fixtures/` | CMC and LI.FI responses recorded on 2026-11-25, trimmed to the fields read |
