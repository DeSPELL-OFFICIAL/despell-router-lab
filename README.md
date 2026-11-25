# DeSpell Router Lab

Hackathon work for the [DeSpell](https://despell.io) AI router, built in the open during December 2026.

DeSpell is an AI wallet: you say what you want, it shows one card with what leaves your wallet, what comes in, and the route, and nothing moves until you sign it. The router behind that card watches every pool it might send you through and tightens or closes a pool the moment something about it changes.

The DeSpell app itself is an existing private product. This repository holds only the parts built for the hackathons below, and it runs as its own app on its own domain.

| Folder | Hackathon | What it shows | Built |
| --- | --- | --- | --- |
| `app/` | All four | The web app at lab.despell.io: one page per hackathon, all built on the same signing card. | from 2026-11-26 |
| `reactive/` | Reactive Omni | A pool setting changes, and a Reactive contract marks that pool as narrowed on-chain within seconds. Quotes leave the marked pool out. | from 2026-11-26 |
| `xlayer/` | X Layer TapeOut | The router's pool judgment rules as a TapeOut NAND circuit on X Layer, so anyone can reproduce each judgment. | from 2026-11-26 |
| `cmc/` | CoinMarketCap API | Tokenized wrappers of one stock ranked by what you actually receive, using CMC RWA prices plus route cost. | from 2026-11-26 |
| `ethglobal/` | ETHGlobal Agentic Markets | A card waiting for your signature is held when its pool changes, with a receipt saying why. | from 2026-12-03 (event start) |

## Rules this code keeps

- Money moves only when the user signs. Contracts and circuits here record, mark and check; they never spend for anyone.
- Marks only tighten. A pool is reopened only after test trades pass again, never because the pool flipped its setting back.
- No keys, API keys or seed phrases in this repository.

## The test-network swap card (`/swap`)

The shared card, live on two test networks: 10 USDC to ETH on Base Sepolia (Uniswap v4, the better of the two `reactive/` test pools, through the Universal Router and Permit2) and on GIWA Sepolia (Uniswap v3 SwapRouter02, WETH/USDC Mock).

- Browser wallets only (EIP-6963 and `window.ethereum`); no WalletConnect.
- Everything the card says about a transaction (amount sent, minimum received, recipient, each approval's spender, amount and expiry) is decoded from the bytes the wallet will sign (`app/src/lib/swap/decode.ts`). Approvals cover this swap's amount only.
- The sign button turns on only after those exact transactions pass a simulation (`eth_simulateV1`) and the page's own check is open. Each contest page passes that check as a gate: `pending` while it runs, `hold` to stop, `ok` to allow.
- A transaction the wallet sent but whose receipt could not be read keeps the card locked until its receipt is read again; a transaction replaced or cancelled in the wallet stops the card.
- Test USDC: on Base Sepolia from Circle's faucet. On GIWA Sepolia the USDC is a mock token anyone can mint, and the card offers that mint from your wallet. The mint is outside the signing card: it sends `mint(your address, 10 USDC)` to the mock token with value 0 and costs gas only.

## Run it

Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev            # the app on http://localhost:3000
pnpm verify         # secret scan, lint, typecheck, tests, build (CI runs the same)
```

Each hackathon folder joins the pnpm workspace when it adds a `package.json`, either at its top or one level down (`reactive/web/package.json`). Its page in the app is `app/src/app/<folder>/page.tsx`. Environment variable names are listed in `.env.example`; values live only in the Vercel project.

## License

MIT
