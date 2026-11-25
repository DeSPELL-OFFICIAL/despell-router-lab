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
