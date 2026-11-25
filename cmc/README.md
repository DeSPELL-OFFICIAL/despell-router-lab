# cmc — one stock, many wrappers, ranked by what $100 actually buys

Part of the CoinMarketCap API hackathon entry (RWA track). Give it a stock ticker such as `NVDA` and it:

1. reads the stock's tokenized wrappers from CoinMarketCap's RWA API (`/v5/real-world-assets/quotes/latest`): each token, its issuer and its CMC price;
2. expands each token to the chains it lives on (`/v2/cryptocurrency/info`, `contract_address[]`), so a wrapper is one token on one chain;
3. asks LI.FI's public quote API how many tokens $100 of USDC on that chain really buys, and what gas the route costs;
4. ranks the wrappers by received value and marks the top one "receives the most".

A wrapper that trades below the stock can still lose once you pay to get into it. That is why the ranking uses route cost, not the price gap alone.

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

The page reuses one measurement: 5 minutes when complete, 1 minute when only a DeSpell check failed, and 5, 10, 20, then 30 minutes while quotes keep failing (usually LI.FI's rate limit). The Buy action only accepts a row that this measured screen shows as buyable, fixes the amount on the server, and asks for at most 20 links a minute per server process.

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
