# reactive/ — Reactive Omni: the router's reflex, on-chain

**Reactive Omni Buildathon · track: Every Second Counts.** When a Uniswap v4 pool on Base Sepolia changes its fee, a
Reactive contract on Lasna hears the event and, through a callback, marks that pool on a `PoolGuard` contract back on
Base Sepolia, about a second later. The lab's swap card reads the mark and quotes around the marked pool.

| For judges | |
| --- | --- |
| The loop | `FeeUpdated` from our hook on Base Sepolia → `PoolReflex.react()` on Reactive Lasna → callback → `PoolGuard.mark()` on Base Sepolia |
| Contracts | `PoolReflex` on Reactive Lasna (5318007): [`0x321dB6a8b9eB320c761a8f801FE4757e60f2484A`](https://lasna.reactscan.net/address/0x321dB6a8b9eB320c761a8f801FE4757e60f2484A) <br> `PoolGuard` on Base Sepolia (84532): [`0xcF269776640D3D19C9c515f3eEAF1DaD53d88378`](https://sepolia.basescan.org/address/0xcF269776640D3D19C9c515f3eEAF1DaD53d88378) <br> `DynamicFeeHook` on Base Sepolia, the event's origin: [`0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000`](https://sepolia.basescan.org/address/0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000) |
| One full loop | fee 0.05% → 10%: [`0x29ade921…b918`](https://sepolia.basescan.org/tx/0x29ade9215a7047a55b12ef0dc95be6e9e3460c4da2ccc24580c159a414bdb918) (Base Sepolia) → reaction [`0x62d7f9b2…5da5`](https://lasna.reactscan.net/tx/0x62d7f9b24a8b7fe73bc616dba6a21b3732e00834745e2f29fe4669d3e8095da5) (Lasna) → mark [`0xc543b11f…b65c`](https://sepolia.basescan.org/tx/0xc543b11fa9b2a632d4fe88d5d3764f8056d694a65e0ee02e4bff9aa51330b65c) (Base Sepolia), 1 s and 5 blocks after the change. All 14 loops: [Measured latency](#measured-latency) |
| Latency | 14 of 14 fee changes marked. Median 1 s by block timestamps, 6.5 Base Sepolia blocks (≈ 1.3 s at 200 ms a block); slowest 2 s, 10 blocks |
| How it was measured | `reflex/scripts/measure.mjs` changes the fee, waits for PoolGuard's `Marked` event, and takes the mark's block against the change's block: the timestamp gap in whole seconds and the block gap. Every run's three transactions are kept in [`deployments/reflex-latency-base-sepolia.json`](deployments/reflex-latency-base-sepolia.json). [Run it yourself](#measure-it-yourself) |
| What Reactive does | It is the only way a mark is written: PoolGuard accepts `mark` only from Reactive's callback proxy on behalf of PoolReflex, and the router's reflex table (which change narrows, which blocks) lives in PoolReflex |
| Demo | The `/reactive` page of the lab app (`app/`): the swap card leaves a marked pool out with a "Left out" row and stops with no route when every pool is marked. [The route demo](#the-route-demo-2026-11-26) shows it on chain, [the demo video's loop](#the-demo-video-loop-2026-11-26) lists the transactions recorded in the first video, and [the live demo video](#the-live-demo-video-2026-11-27) those of the second, with a real swap |

Why it matters: the DeSpell router tightens a pool the moment the pool changes a setting, before any AI review. Today a
server patrol does that and can take up to 60 seconds, long enough for a pool to raise its fee between a quote and a
signature. On Reactive Omni the mark lands about a second after the change, and anyone can read it with
`statusOf(poolId)`.

What is new: the DeSpell app itself is an existing, private product. Everything in this folder (the hook, both
Reactive contracts, the scripts and every transaction) and the `/reactive` page that reads the marks were built during
the buildathon; the first contract went on-chain on 2026-11-25 at 17:36 UTC. The reflex table PoolReflex carries is the private
router's rule set, brought in as a specification, not as code.

The pieces:

1. **A test pool whose setting can change** — a Uniswap v4 ETH/USDC pool on Base Sepolia with our hook. Changing
   its fee emits one `FeeUpdated` event. *(`src/`)*
2. **The reflex** — PoolReflex on Reactive Lasna hears `FeeUpdated` and, through a callback, marks the pool as
   narrowed on PoolGuard on Base Sepolia. Anyone reads the mark with `statusOf(pool)`. *(`reflex/`)*
3. **A quote that reads the marks** — the app's swap card on `/reactive` quotes both test pools, leaves a marked one
   out with a "Left out" row, and stops with no route when both are marked. *(`app/src/components/reactive/`)*

Marks only tighten, and nothing here moves anyone's money.

### Measure it yourself

```sh
# Read a mark (no key): 0 open, 1 small cap, 2 narrowed, 3 blocked
cast call 0xcF269776640D3D19C9c515f3eEAF1DaD53d88378 "statusOf(bytes32)(uint8)" \
  0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4 --rpc-url https://sepolia.base.org

# Measure the loop again (the hook and PoolGuard owner's key; run from reflex/)
GUARD=0xcF269776640D3D19C9c515f3eEAF1DaD53d88378 REFLEX=0x321dB6a8b9eB320c761a8f801FE4757e60f2484A \
  node --env-file=<your env file> ../scripts/with-key.mjs -- node scripts/measure.mjs
node scripts/report.mjs     # rebuilds the latency table below and the page's data from the record
```

## The test pool (Base Sepolia, chain 84532)

| What | Address / value |
| --- | --- |
| Hook `DynamicFeeHook` | [`0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000`](https://sepolia.basescan.org/address/0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000) |
| Pool id | `0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4` |
| Pool key | ETH (`0x0`) / [USDC](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) · fee `0x800000` (dynamic) · tick spacing 10 · hook above |
| Start | tick −202230 ≈ 1650.83 USDC per ETH · LP fee 500 (0.05%) |
| Uniswap v4 ([official list](https://docs.uniswap.org/contracts/v4/deployments)) | PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` · StateView `0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4` · V4Quoter `0x5e6B8B8AFA7e5CEF6C09dd2A67aBA9FB12C75623` · PositionManager `0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80` |

Machine-readable copy: [`deployments/base-sepolia.json`](deployments/base-sepolia.json).

### Test pool B

A second pool on the same hook, so PoolReflex watches it too and the quote has another route when pool A is marked.
`script/LaunchSecondPool.s.sol` opens it at pool A's price and seeds an ETH-only position; with less liquidity than A,
it pays a little less, so the quote takes A while both are open.

| What | Value |
| --- | --- |
| Pool id | `0xa7692fed527766fb44a78fb84faffa4cc759bb29002969b87e571366db28efc2` |
| Pool key | as pool A, with tick spacing 60 |
| Start | tick −202170 (pool A's price at block 63680065) · LP fee 500 (0.05%) |
| Liquidity | 0.01 ETH, position 34387, ticks −202140 to −201900 |
| Opened by | `reflex/scripts/route-demo.mjs`; its transactions go to [`deployments/route-demo-base-sepolia.json`](deployments/route-demo-base-sepolia.json) |

Opening a pool emits `FeeUpdated(0 → 500)`, and PoolReflex marks every new pool narrowed until the operator reopens it.

#### The route demo (2026-11-26)

`route-demo.mjs` opened pool B, then held the app's `/reactive` card in three states while it was captured. Every
transaction is on Base Sepolia, sent by the hook and PoolGuard owner. The marks are PoolGuard's callbacks from
Reactive Network.

| Step | Transaction | Block | PoolGuard's answer |
| --- | --- | --- | --- |
| Open pool B · `Initialize`, `FeeUpdated(0 → 500)` | [`0x454e818d…6367`](https://sepolia.basescan.org/tx/0x454e818dd215919c0e59d1c4169be131aca2f6390c838dcce0b85e72a27d6367) | 63680065 | narrowed (2), [`0x5a6aabce…1b67`](https://sepolia.basescan.org/tx/0x5a6aabcedafaf8084df8df9b843a30a1b6e90d3d64c21e2422a724515a421b67) · 6 blocks |
| Seed pool B with 0.01 ETH (position 34387) | [`0xe7147e4d…1959`](https://sepolia.basescan.org/tx/0xe7147e4dd657d425ed16ba23161abb66868ff10a2e6ab0cb12a7e9e911671959) | 63680069 | — |
| Pool A fee 0.05% → 10% | [`0xf4edd3e5…c98c`](https://sepolia.basescan.org/tx/0xf4edd3e54c4dcce01d029331b3099606a135aaf00c0c72869e4ce092da98c98c) | 63680118 | narrowed (2), [`0xb6c2abda…73a4`](https://sepolia.basescan.org/tx/0xb6c2abdaabd2c58ef9aab89642146f3b527129e585c03cf72edbda1c4ba173a4) · 7 blocks |
| Reopen pool B | [`0x8a1323bc…16eb`](https://sepolia.basescan.org/tx/0x8a1323bc92f8b8fe3fa93d4b1bc5650c9f7f3833079ecd843791eafe771d16eb) | 63685019 | — |
| Pool A fee 10% → 0.05% | [`0x2786376c…5b82`](https://sepolia.basescan.org/tx/0x2786376c7fa5c38d8cbb9586f146299c9bdec5aa711d5877ca25b2e710145b82) | 63685173 | kept narrowed (`MarkKept`), [`0x9f038c6e…8254`](https://sepolia.basescan.org/tx/0x9f038c6e15427db6046c9cd868eb733b940e96374720a37184edbb1c10db8254) · 5 blocks |
| Reopen pool A | [`0x52725fac…0ba8`](https://sepolia.basescan.org/tx/0x52725facddf302bebb09e9d4dfa096c2898e270a1cefe3e717420816a6b40ba8) | 63685227 | — |

| State | Status A · B | The card, 10 USDC → ETH |
| --- | --- | --- |
| no-route | 2 · 2 | Route None, a "Left out" row for each pool, "No route · every pool is marked on-chain" |
| left-out | 2 · 0 | Route test pool B, +0.00595765 ETH, a "Left out" row for pool A |
| both-open | 0 · 0 | Route test pool A, +0.0060092 ETH (A pays more) |

Both pools ended at 0.05% and open.

What the card cannot catch: it reads the marks right before it asks the wallet for each transaction, so a mark that
lands while the wallet's window is open is seen only before the next one. The plan's deadline bounds how long that
window can be. Between a plan's transactions, that read also decides in place of the 6-second age rule, so a gap in
the polling does not stop a swap after its approval.

#### The demo video loop (2026-11-26)

`reflex/scripts/loop-demo.mjs` walks one loop on pool A a step at a time while the `/reactive` card is recorded: the
fee up to 10%, back to 0.05%, then the operator's reopen. Its record is
[`deployments/loop-demo-base-sepolia.json`](deployments/loop-demo-base-sepolia.json). The fee changes and the reopen
are sent on Base Sepolia by the hook and PoolGuard owner; the reactions are PoolReflex on Reactive Lasna; the answers
are PoolGuard's callbacks on Base Sepolia.

| Step | Change (Base Sepolia) · block | Reaction (Lasna) | PoolGuard's answer · block | Change → answer |
| --- | --- | --- | --- | --- |
| Pool A fee 0.05% → 10% | [`0x32e5e8a6…d963`](https://sepolia.basescan.org/tx/0x32e5e8a6b3ac3f1ced1f02eef31f904e67c3c6b3cccc086f892cd9ed51efd963) · 63720683 | [`0xfead3e88…0f66`](https://lasna.reactscan.net/tx/0xfead3e889deb88386a83b45177f0b0a789d8dbf0583a6fe3642b96023cc70f66) | narrowed (2), [`0xc60c35a1…2a11`](https://sepolia.basescan.org/tx/0xc60c35a18a86784ac96f766ad96336e7443754354d17ae146b50ca7dc2372a11) · 63720688 | 1 s · 5 blocks |
| Pool A fee 10% → 0.05% | [`0xe60febce…5bc7`](https://sepolia.basescan.org/tx/0xe60febcee6c71413520734f7cdc7536f65f92ef5cc876051241687b136935bc7) · 63720829 | [`0x3e7b1fcd…2819`](https://lasna.reactscan.net/tx/0x3e7b1fcde1a4fca56d51d8c016dceadf44cd5d7c35dd86f693c62b538f4a2819) | kept narrowed (`MarkKept`), [`0xb0ea8485…3f4e`](https://sepolia.basescan.org/tx/0xb0ea8485162692cec504978613f511db47155105c65fd03b508ae57075303f4e) · 63720836 | 2 s · 7 blocks |
| Reopen pool A | [`0xce50602d…9a2f`](https://sepolia.basescan.org/tx/0xce50602dd2172edb7e77fcd54052d294e989a1aee5bd0c277ce1f45848c89a2f) · 63720946 | — | — | — |

The card in the video takes test pool A while both pools are open, switches to test pool B with a "Left out" row for
pool A once the mark lands, stays on B after the fee goes back, and returns to A after the reopen. Pool A ended at
0.05% and open. The two chains stamp time separately, so a Lasna timestamp can read a second earlier than the Base
Sepolia change it reacts to; the gaps above use Base Sepolia blocks only.

A run of the same script minutes earlier (its recording stopped on a bug in the recorder, not in the loop): fee to
10% [`0xbf4770ea…a200`](https://sepolia.basescan.org/tx/0xbf4770eaeabb4144e5de3c64ec71bf5653d62359ed49626e7e3a89682b6fa200)
→ reaction [`0x555e5587…e892`](https://lasna.reactscan.net/tx/0x555e55871943a3820c15f46cdaec3a67c499dc98bf28bd55807624509304e892)
→ mark [`0x9efa0ad2…90af`](https://sepolia.basescan.org/tx/0x9efa0ad22673b97deb89fdb76fb5a8a0ffa8ddf65ab6b8e197dd0bf9c58190af),
1 s · 3 blocks; back to 0.05% [`0x3816efff…8e89`](https://sepolia.basescan.org/tx/0x3816efff66e180c67877a3583a56539939b49b5b7955925d1a31a2605d538e89)
→ reaction [`0x81a95ed4…6d4e`](https://lasna.reactscan.net/tx/0x81a95ed4c3408364c342c3d65e13fd8e8cdeec18ef65647655ba4c033d496d4e)
→ `MarkKept` [`0x86291a2d…762c`](https://sepolia.basescan.org/tx/0x86291a2d574f6a415e395d627d1f7412af9c7307583d2ec176a8b74d5fd5762c),
4 blocks within the same second; reopen [`0xcb49565f…2e82`](https://sepolia.basescan.org/tx/0xcb49565f94b3eb0f4ec74549da16b65f8f94d3e2bcd7c179f2f609f3adfe2e82).

#### The live demo video (2026-11-27)

[Watch the live Reactive demo (2:22)](https://github.com/DeSPELL-OFFICIAL/despell-router-lab/releases/download/hackathon-demos-2026-11/demo-v3.mp4). It shows the loop next to the pool owner's terminal, the explorers, and a testnet swap. `loop-demo.mjs` ran
with `STEPS=raise,raise-b,lower,reopen,lower-b,reopen-b`; its record is
[`deployments/live-video-base-sepolia.json`](deployments/live-video-base-sepolia.json).

| Step | Change (Base Sepolia) · block | Reaction (Lasna) | PoolGuard's answer · block | Change → answer |
| --- | --- | --- | --- | --- |
| Pool A fee 0.05% → 10% | [`0xfcc5fa72…dccc`](https://sepolia.basescan.org/tx/0xfcc5fa722eadb2931cf4b7287ed66f6b10bf139992346b10e7b59d0a134bdccc) · 64229895 | [`0xef898810…a06f`](https://lasna.reactscan.net/tx/0xef8988107b347a9c5b935d35f87a934c7b4cb966ed6f2ff0c8447b211c85a06f) | narrowed (2), [`0xef1b49a4…70c7`](https://sepolia.basescan.org/tx/0xef1b49a4e93a4c3d47cb418bc5303ddc45196509b6f0dc1018680f5ac5bf70c7) · 64229903 | 2 s · 8 blocks |
| Pool B fee 0.05% → 10% | [`0xa7d5e4b7…3eeb`](https://sepolia.basescan.org/tx/0xa7d5e4b7540162b5738c2c13aee31d015eb3f52f2476b7f322071fcbb04c3eeb) · 64230260 | [`0x61775eec…b6eb`](https://lasna.reactscan.net/tx/0x61775eecf740633e5f335eebdb523e6d273a6b5bbcf2f52ab0d4636a4976b6eb) | narrowed (2), [`0xef909cdb…f2ee`](https://sepolia.basescan.org/tx/0xef909cdb0863d1f8474ffbe497f2edee74a881b0c0abde3010b4ee4aec6ff2ee) · 64230264 | 1 s · 4 blocks |
| Pool A fee 10% → 0.05% | [`0x6238d2a6…c11d`](https://sepolia.basescan.org/tx/0x6238d2a68c08bb9953b99b05772e9c4dcc2555e615fe64e638fcc94b023cc11d) · 64230334 | [`0xbe417d2a…3af1`](https://lasna.reactscan.net/tx/0xbe417d2ab2d962859e6aaff8a0de32088e8120eb5f6740dc0c9f05a1e8c63af1) | kept narrowed (`MarkKept`), [`0xed2ed36a…1299`](https://sepolia.basescan.org/tx/0xed2ed36a1218291d73c11ad7e97b1019138bb4f39910bb36dc213fc1c3b31299) · 64230339 | 1 s · 5 blocks |
| Reopen pool A | [`0xed7b7d63…3f11`](https://sepolia.basescan.org/tx/0xed7b7d630a43a5f2a3ab3a8d33f18cd2ba2347c7437fbf325e0b577cabbb3f11) · 64230412 | — | — | — |
| Pool B fee 10% → 0.05% | [`0x4348bd3e…f755`](https://sepolia.basescan.org/tx/0x4348bd3e8eac8ab98afba9b4a9737231eda3f122eb594667c71863e11cf6f755) · 64230489 | [`0x59775771…914e`](https://lasna.reactscan.net/tx/0x5977577138d175d01a5a744f1a2e3483c5f871ec17c0b03ef79a2beb86bf914e) | kept narrowed (`MarkKept`), [`0xf085032b…d54e`](https://sepolia.basescan.org/tx/0xf085032baa2564c91ac0b81da9cdd568361b94ef2c9e32f4f63bf64c2099d54e) · 64230495 | 1 s · 6 blocks |
| Reopen pool B | [`0x90564b37…3727`](https://sepolia.basescan.org/tx/0x90564b3769598e9e1c6075f927621a8e1f010bb142e2363455c027f673953727) · 64230558 | — | — | — |

Between the first two steps, with pool A marked, the card quoted through pool B and the pool owner's test wallet
signed the swap: 10 USDC in, 0.00595765 ETH out, in three transactions (USDC approval for Permit2
[`0x6b2d3f61…2822`](https://sepolia.basescan.org/tx/0x6b2d3f612a0322dfa1e52c594c65ad2f9bea6dbb78e7e46d79e0ba9b9e212822),
Permit2 approval for the Universal Router
[`0x33892647…7c5f`](https://sepolia.basescan.org/tx/0x338926472731100845aa9cf5bcd114a53dca93e30aebeb71f10c8d1627877c5f),
the swap [`0xd0ab8f0b…a0ea`](https://sepolia.basescan.org/tx/0xd0ab8f0b77946f83eac41e75378a6cbceb57b8301988437dfb0cde32b8d5a0ea)
· 64230145). With pool B marked too, the card stopped with no route; after the fee went back and the owner reopened
pool A, it quoted through A again. Both pools ended at 0.05% and open.

### The event a Reactive contract subscribes to

```solidity
event FeeUpdated(PoolId indexed poolId, uint24 oldFee, uint24 newFee); // fees in hundredths of a bip: 500 = 0.05%
```

- `topic0` = `0x96a011a1e8a72dbc16d5af5d8f0db6bf107a76580682a94073bb6ffec86a0872` (`keccak256("FeeUpdated(bytes32,uint24,uint24)")`)
- `topic1` = the pool id. Emitted by the hook address above.
- One event per change. The Uniswap v4 PoolManager emits nothing when a dynamic fee changes, and other hooks announce
  fee changes in their own ways, so this hook gives the change a single, known shape.
- The first one for a pool (`0 → 500`) comes in the same transaction as the PoolManager's `Initialize`. For this pool
  that is block 63531662. A subscriber treats it as the baseline, not as a change: the Reactive contract below
  subscribes after it.

### Transactions

| Step | Transaction | Block |
| --- | --- | --- |
| Deploy hook (CREATE2, salt `0x…0724`) | [`0xb09a10fe…b6f0`](https://sepolia.basescan.org/tx/0xb09a10fe4f094246a22c69f3fbea39eca1a02ffea5f2ca81f6a1c2f348e7b6f0) | 63531658 |
| Initialize pool · `FeeUpdated(0 → 500)` | [`0xc2b897a6…6251`](https://sepolia.basescan.org/tx/0xc2b897a63af74cf982ebf0fdd3dc6e7bfac0cc12359a0577bda548588c6d6251) | 63531662 |
| Seed 0.01 ETH (position 34377) | [`0xeda4ebee…8c2a`](https://sepolia.basescan.org/tx/0xeda4ebee75eb55c7f2b0ed418e6b65920d6b6c3a6bd910290cbe11efb0e38c2a) | 63531666 |
| Change fee · `FeeUpdated(500 → 100000)` | [`0xb96244b8…d474`](https://sepolia.basescan.org/tx/0xb96244b8cd9fc54ac2b4c852c0f912e94ea4ba4cbb1a79259c857e85ceb8d474) | 63531756 |
| Seed 0.03 ETH (position 34378) | [`0x62df5091…646b`](https://sepolia.basescan.org/tx/0x62df50912f566327829050968563ad44a4757799e4c9b281d08e5a263f61646b) | 63534168 |
| Change fee back · `FeeUpdated(100000 → 500)` | [`0xe784190b…f38d`](https://sepolia.basescan.org/tx/0xe784190b659e50a9bc191c5d21b0e33c546c5dca88ccb4d120a400f7cdb8f38d) | 63534286 |

The pool now rests at 0.05% with 0.04 ETH of liquidity.

### Check it yourself

```sh
# The fee the PoolManager charges now, from Uniswap's StateView (last value is the LP fee)
cast call 0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4 "getSlot0(bytes32)(uint160,int24,uint24,uint24)" \
  0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4 --rpc-url https://sepolia.base.org

# Pool state and a 10 USDC -> ETH quote from Uniswap's V4Quoter (no key needed)
forge script script/Quote.s.sol --rpc-url base_sepolia
forge script script/Quote.s.sol --rpc-url base_sepolia --fork-block-number 63534200   # while the fee was 10%
```

| Block | LP fee | Liquidity in the pool | 10 USDC → ETH (V4Quoter) |
| --- | --- | --- | --- |
| 63531666 | 0.05% | 0.01 ETH | 0.006018 ETH |
| 63531756+ | 10% | 0.01 ETH | 0.005422 ETH |
| 63534200 | 10% | 0.04 ETH | 0.005444 ETH |
| 63534286+ | 0.05% | 0.04 ETH | 0.006045 ETH |

### Liquidity

The pool holds ETH only, in positions that start at the pool price and reach about 2% above it. ETH-only seeding
needs no token approvals. It serves USDC → ETH swaps (the direction the demo card uses); ETH → USDC has liquidity only
after someone has bought ETH from it. The pool is small: quotes are good up to a few tens of USDC.

## Contracts

- [`src/DynamicFeeHook.sol`](src/DynamicFeeHook.sol) — built on OpenZeppelin's `BaseHook`. Its only hook flag is
  `afterInitialize`, so the PoolManager calls it once per pool and never during swaps or liquidity changes.
  - Only the owner can create pools on it (`afterInitialize` checks the sender), so its `FeeUpdated` stream carries
    only our pools. Dynamic-fee pools only.
  - `setFee(key, newFee)` — owner only. Calls `PoolManager.updateDynamicLPFee` and emits `FeeUpdated`. Setting the
    current fee again reverts (`FeeUnchanged`), so every event is a real change.
  - `feeOf(poolId)` — the LP fee the PoolManager charges now.
  - It never holds, takes or moves tokens.
  - The owner is immutable and is the lab's shared test wallet, so this hook is for testnets only.
  - The constructor accepts an `initialFee` of 0, which would make the first event read `0 → 0`. The deployed hook
    uses 500 and its source stays as deployed, so the bytecode can be rebuilt from this repository. If it is ever
    redeployed, make the constructor reject 0.

## The reflex: PoolReflex and PoolGuard (`reflex/`)

```
Base Sepolia                     Reactive Lasna                         Base Sepolia
hook emits FeeUpdated  ───────►  PoolReflex.react()  ── callback ──►   PoolGuard.mark()  →  statusOf(poolId) = 2
(pool id, 500 → 100000)          reflex table: fee_changed → 2          via Reactive's callback proxy
```

- **`PoolReflex`** (Reactive Lasna, built on `reactive-lib-omni`) subscribes to exactly one thing: `FeeUpdated` from
  the hook above, on Base Sepolia. Its `react()` looks the change up in the router's reflex table and asks, through
  `requestCallbackV_1_0`, for PoolGuard to mark the pool. It never asks for anything looser.
- **`PoolGuard`** (Base Sepolia) accepts `mark` only from Reactive's callback proxy, and only on behalf of PoolReflex
  (the proxy writes the requesting contract's address into the first argument). Anyone reads
  `statusOf(poolId)` or `markOf(poolId)`.

| Status | Meaning in the router |
| --- | --- |
| 0 | open |
| 1 | small cap |
| 2 | narrowed: the router caps the pool at 0.1x its usual limit |
| 3 | blocked |

| Deployed | Address | Transaction |
| --- | --- | --- |
| `PoolReflex` on Reactive Lasna (5318007) | [`0x321dB6a8b9eB320c761a8f801FE4757e60f2484A`](https://lasna.reactscan.net/address/0x321dB6a8b9eB320c761a8f801FE4757e60f2484A) | [deploy `0xacd8adde…56fb`](https://lasna.reactscan.net/tx/0xacd8addee54c22fc24ecebd70737345afe4c0ad206fcd073e2cd00d8123b56fb) · [setGuard `0x990af1eb…27bc`](https://lasna.reactscan.net/tx/0x990af1eb99fd4b05fb45b6732168c91067695ec3eaf7004c8ea8b888a41727bc) |
| `PoolGuard` on Base Sepolia (84532) | [`0xcF269776640D3D19C9c515f3eEAF1DaD53d88378`](https://sepolia.basescan.org/address/0xcF269776640D3D19C9c515f3eEAF1DaD53d88378) | [deploy `0x9f71ffe7…c2de`](https://sepolia.basescan.org/tx/0x9f71ffe7042620c4e99ac6d8de11e01c25db1bd315aeb458fad1e21b5c5ec2de) |

PoolReflex's subscription is live on Reactive Network: `rnk_getFilters` lists chain 84532, the hook, topic0
`FeeUpdated` and the other topics open, with PoolReflex active. Machine-readable copy: `deployments/reflex.json`.

The rules it keeps:

- Marks only tighten. A callback asking for the same or a looser status changes nothing (`MarkKept`), and an unknown
  status is read as blocked.
- Flipping the setting back does not reopen a pool: `500 → 100000` and then `100000 → 500` leaves it narrowed.
- Only the owner reopens (`reopen(poolId)`): the server, after the pool's test trades pass again.
- A pool created on the hook after PoolReflex subscribed reports its first fee as `0 → initialFee`, so it starts
  narrowed until it is tested and reopened, the router's rule for untested pools.
- Neither contract moves anyone's money. PoolGuard's ETH pays the callback proxy's fees; PoolReflex's lREACT pays for
  reactive transactions. Testnet limits: `setGuard` works once, and neither contract has a withdraw, so leftover
  test funds stay in them.

The reflex table is the router's, change kind by change kind: code, token code, implementation or failed-sell
changes block (3); owner, fee, reserve or round-trip-loss changes narrow (2); `paused` and `stale` do not mark. The
test pool can only change its fee, so only `fee_changed` is wired to an event.

### Measured latency

<!-- reflex-latency:begin -->
Measured 2026-11-25T18:46:11.285Z: 14 of 14 fee changes marked on PoolGuard. Median 1 s (6.5 Base Sepolia blocks), fastest 1 s, slowest 2 s.

| # | Fee change | Change (Base Sepolia) | Reaction (Lasna) | Mark (Base Sepolia) | Blocks | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.05% → 10% | [`0x29ade921…b918`](https://sepolia.basescan.org/tx/0x29ade9215a7047a55b12ef0dc95be6e9e3460c4da2ccc24580c159a414bdb918) | [`0x62d7f9b2…5da5`](https://lasna.reactscan.net/tx/0x62d7f9b24a8b7fe73bc616dba6a21b3732e00834745e2f29fe4669d3e8095da5) | [`0xc543b11f…b65c`](https://sepolia.basescan.org/tx/0xc543b11fa9b2a632d4fe88d5d3764f8056d694a65e0ee02e4bff9aa51330b65c) | 5 | 1 |
| 2 | 10% → 0.05% | [`0x8f8bdaff…f222`](https://sepolia.basescan.org/tx/0x8f8bdaff843bf37b873a26b7882cdd7ecb0d6925342e90eff9e74169d043f222) | [`0x585a2868…4878`](https://lasna.reactscan.net/tx/0x585a2868c9c0a0ec2082451228d0badd8c82ef070cab90381fbbbbfb98214878) | [`0xa3a11a91…47f6`](https://sepolia.basescan.org/tx/0xa3a11a91c295ce13d70f636c6082f255de4228afd83d031f05dcc8be55de47f6) | 8 | 2 |
| 3 | 0.05% → 10% | [`0xec5c555d…3ef4`](https://sepolia.basescan.org/tx/0xec5c555db3bd06fda4f7b89adf2b20665da5175117d3a540a95cb5e17d083ef4) | [`0x04930bbe…1687`](https://lasna.reactscan.net/tx/0x04930bbeadace95207d40283c5e97d23a0328ed959820a2803d801c036c41687) | [`0x5a8d0eb8…9ced`](https://sepolia.basescan.org/tx/0x5a8d0eb87fd90174d5fa7869ed2b6b175414bab90c2f541d51a89120fd599ced) | 4 | 1 |
| 4 | 10% → 0.05% | [`0x6c0af474…c7e9`](https://sepolia.basescan.org/tx/0x6c0af474299a3407100630e57600feaaf2dcd93a71989a657f9854afcfc0c7e9) | [`0x729809ec…e84e`](https://lasna.reactscan.net/tx/0x729809ecc1a9b376e8554d14577d2f8deafee6400bb0404a37b99eae4076e84e) | [`0x3371a5aa…7580`](https://sepolia.basescan.org/tx/0x3371a5aa6fc28b58a1960799df2437e8027692f4691b4517fc716364421c7580) | 6 | 1 |
| 5 | 0.05% → 10% | [`0xcc07574c…5a74`](https://sepolia.basescan.org/tx/0xcc07574ca82562ad63949080df99cf427cb82e69a7ae91f4951f941212ff5a74) | [`0x08f1f455…00db`](https://lasna.reactscan.net/tx/0x08f1f455f02414e1ea6e2f5ffaa0599872ba2ad78581e3b05ff488c0abec00db) | [`0x9465492c…8a34`](https://sepolia.basescan.org/tx/0x9465492c9e114e353a741b11556b9edffa2639a4990af5123a4a5aabd1418a34) | 5 | 1 |
| 6 | 10% → 0.05% | [`0xeb4724b3…b22e`](https://sepolia.basescan.org/tx/0xeb4724b3f5179c42b512c0ef453327e8a388df44b08ce87d0c694ca17f61b22e) | [`0xd4ad5e32…3858`](https://lasna.reactscan.net/tx/0xd4ad5e32a990f2c14269f680f11f069ea0ed4a4696c1da6b72cbce5dc19d3858) | [`0x4624dc0a…8990`](https://sepolia.basescan.org/tx/0x4624dc0ad0f0e7ac95e42dee307bbda6cfb907a605683a3ab550f0d359178990) | 8 | 1 |
| 7 | 0.05% → 10% | [`0xe8548b29…9883`](https://sepolia.basescan.org/tx/0xe8548b29ba35d8334f36f4569eb807a24a86629b1b39d9c5d94c70f874ac9883) | [`0x1dfda010…5842`](https://lasna.reactscan.net/tx/0x1dfda010401913307ca3b20c90fa1f059d2212f7b8cd5993d096f0f0ed495842) | [`0x4efabf75…1c4f`](https://sepolia.basescan.org/tx/0x4efabf75223bc382fc16b85e4e0fd065fdd77e80956280051b5b5cfc887e1c4f) | 5 | 1 |
| 8 | 10% → 0.05% | [`0xb30cba20…1595`](https://sepolia.basescan.org/tx/0xb30cba20b995bd227061689f2b0786ea958b77dceba08d9edf90b0c51cca1595) | [`0x123f5ea8…a8ca`](https://lasna.reactscan.net/tx/0x123f5ea88bac896fa8d8bb0a835bad08e5fd2a12c998a501696939662e99a8ca) | [`0x610be8ba…2c75`](https://sepolia.basescan.org/tx/0x610be8baca1ab379d8780d421500e9df3bb216cb49bcae72ec0ba37ddec22c75) | 7 | 2 |
| 9 | 0.05% → 10% | [`0xc4431a1a…74e5`](https://sepolia.basescan.org/tx/0xc4431a1abfc2a9f312d43b2ab7b877501a93068ae41c23f8b1e89a5a0b1174e5) | [`0x59a9c40c…e81a`](https://lasna.reactscan.net/tx/0x59a9c40c9c359ef4595d701423153026fafda0f084bbeaf8ca72d85457ffe81a) | [`0x8ebd81dd…084e`](https://sepolia.basescan.org/tx/0x8ebd81dd6d5cc63acf2b033b3db8cbb8b1164a746a787578cb1f228d2583084e) | 4 | 1 |
| 10 | 10% → 0.05% | [`0x7b12fa4d…5a58`](https://sepolia.basescan.org/tx/0x7b12fa4ddc76e5b21ef83413ddc72c776272a1f14cb751625660b370ab075a58) | [`0xbfdaab2c…cef1`](https://lasna.reactscan.net/tx/0xbfdaab2cf68bea2280b06cd17a082c6fef25f86ea3f87314082eca13b3bbcef1) | [`0x317cff40…a243`](https://sepolia.basescan.org/tx/0x317cff406458dbd7e56068e11dbf0e5fdea82d1ee7dfa4bea12280372ef9a243) | 8 | 2 |
| 11 | 0.05% → 10% | [`0x37c45c92…cc57`](https://sepolia.basescan.org/tx/0x37c45c922695e0d9cc58b458449b58f682a02877fa0b4328d81b0eea59cdcc57) | [`0xb28035ce…1daf`](https://lasna.reactscan.net/tx/0xb28035cedbeab7ff204b4137c23a9bc3701d88f582a8094821d2efe2ad941daf) | [`0xe35bc03e…b25b`](https://sepolia.basescan.org/tx/0xe35bc03edfbf3cb87083b1ccacccc8f11211edef2e342783ad6d9bfb6e68b25b) | 7 | 2 |
| 12 | 10% → 0.05% | [`0xb707e7b4…ed65`](https://sepolia.basescan.org/tx/0xb707e7b422695f98e543e2a7f5cc5cefa6908c86372ebb7d11a427158227ed65) | [`0x6ee17091…13b2`](https://lasna.reactscan.net/tx/0x6ee1709131f9ef1bb35557abeeeff47bf9bd6beb06fb91c2e03ede4ab7ec13b2) | [`0x16849041…a444`](https://sepolia.basescan.org/tx/0x16849041b69416aedf9047c2c0d4f8502d7914622f63416e992b56041b6ba444) | 5 | 1 |
| 13 | 0.05% → 10% | [`0x6098230f…592b`](https://sepolia.basescan.org/tx/0x6098230fd4042a9f27879ed52cf07e7719a8a33835817f4f1c10f0b208f3592b) | [`0xf8a3363c…d73a`](https://lasna.reactscan.net/tx/0xf8a3363c5d79fb8fdbeb444f726e3ebbfeb9d241e5a4c4c0466ce20ff829d73a) | [`0x5afcca2d…9e54`](https://sepolia.basescan.org/tx/0x5afcca2de153e1f73354d4680a91e2381771c04cc01e004c722899a0c94c9e54) | 8 | 2 |
| 14 | 10% → 0.05% | [`0xfe8105fa…9f88`](https://sepolia.basescan.org/tx/0xfe8105fad2e14f7fe788dda6caff735ddaf485e4681ec75f4b15b78a38779f88) | [`0xb59c4c9d…e7f5`](https://lasna.reactscan.net/tx/0xb59c4c9d4d6bf24edaffb45fdcac9676c1c26c425f7a29e8244e6672a05ee7f5) | [`0x3665bb16…cd68`](https://sepolia.basescan.org/tx/0x3665bb1635edd89ff9b06de450e0ce2f87a3c5518b1713ad0d99560473a4cd68) | 10 | 2 |
<!-- reflex-latency:end -->

`reflex/` is its own Foundry project: `reactive-lib-omni` needs solc ^0.8.29, while the hook above stays on 0.8.26 so
its deployed bytecode can be rebuilt.

| Script (`reflex/`) | Does | Chain |
| --- | --- | --- |
| `script/GetLreact.s.sol` | Buys lREACT with Base Sepolia ETH through Reactive's faucet | Base Sepolia |
| `script/DeployReflex.s.sol` | Deploys and funds PoolReflex (subscribes in its constructor) | Lasna |
| `script/DeployGuard.s.sol` | Deploys and funds PoolGuard, accepting marks from PoolReflex only | Base Sepolia |
| `script/SetGuard.s.sol` | Points PoolReflex at PoolGuard, once | Lasna |
| `script/Reopen.s.sol` | The owner reopens a test pool (`POOL_ID`, default pool A) | Base Sepolia |
| `scripts/measure.mjs` | Changes the fee, waits for the mark, records the three transactions, reopens, repeats | both |
| `scripts/route-demo.mjs` | Opens test pool B, then holds three states for the app's card: both marked, only A marked, both open | Base Sepolia |
| `scripts/loop-demo.mjs` | The loop a step per signal, for a screen recording: a pool's fee to 10% (marked), back to 0.05% (mark kept), reopen. `STEPS` picks pool A, pool B or both (both marked: no route); each pool's three steps run in that order, so a finished run leaves both open. Each run replaces its record (`OUT`), by default the first video's | Base Sepolia |
| `scripts/chain.mjs` | The JSON-RPC reads, forge runs, reaction lookup and mark wait the three scripts above share | — |
| `scripts/report.mjs` | Turns a measurement into `deployments/reflex-page.json` and this README's latency table (no key) | — |

## Build and test

```sh
scripts/install-deps.sh               # pinned: forge-std, OpenZeppelin uniswap-hooks (v4-core, v4-periphery), reactive-lib-omni
forge test                            # unit tests on a local PoolManager
FOUNDRY_PROFILE=fork forge test       # runs the scripts below against Uniswap's real Base Sepolia contracts (needs network)

cd reflex
forge test                            # PoolGuard and PoolReflex rules, and the whole loop with a stand-in system contract and proxy
FOUNDRY_PROFILE=fork forge test       # the real hook on Base Sepolia, and Lasna's real system contract (needs network)
node --test scripts/*.test.mjs        # the report builder
```

The root of this repository has no git submodules (other folders share it), so the dependency pins live in
`scripts/install-deps.sh` (the same commits as the Uniswap Foundation v4-template).

## Scripts

Scripts that send transactions read the key from `PRIVATE_KEY`. `scripts/with-key.mjs` passes a key from an env file
to one command and scrubs it from the output; the key is never an argument or written to disk:

```sh
node --env-file=<your env file> scripts/with-key.mjs -- forge script script/SetFee.s.sol --rpc-url base_sepolia --broadcast
```

| Script | Does | Inputs |
| --- | --- | --- |
| `Launch.s.sol` | Mines the hook address, deploys the hook, initializes the pool, seeds ETH (3 transactions) | `SEED_WEI` |
| `LaunchSecondPool.s.sol` | Opens test pool B on the same hook at pool A's price and seeds ETH (2 transactions) | `SEED_WEI` |
| `SetFee.s.sol` | Changes the LP fee (1 transaction, one `FeeUpdated`) | `NEW_FEE` (500 = 0.05%, 100000 = 10%), `TICK_SPACING` (10 = pool A, the default; 60 = pool B) |
| `Seed.s.sol` | Adds another ETH-only position at the current price | `SEED_WEI`, `TICK_SPACING` |
| `Quote.s.sol` | Read-only: pool state and a USDC → ETH quote | `USDC_IN` (default 10 USDC), `TICK_SPACING` |
| `Status.s.sol` | Read-only: the deployer's balances | — |
| `BridgeToBaseSepolia.s.sol` | Moves test ETH from Ethereum Sepolia through Base's official bridge | `BRIDGE_WEI` |

The hook address depends on the exact creation code (`bytecode_hash = "none"` keeps it the same on every machine),
the owner and the initial fee. Testnet only.
