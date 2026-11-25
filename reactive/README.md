# reactive/ — Reactive Omni: the router's reflex, on-chain

When a pool the DeSpell router might use changes a setting, the router tightens that pool at once, before any AI
review. Today a server patrol does this and can take up to 60 seconds. This folder moves the reflex on-chain:

1. **A test pool whose setting can change** — a Uniswap v4 ETH/USDC pool on Base Sepolia with our hook. Changing
   its fee emits one `FeeUpdated` event. *(`src/`, live)*
2. A Reactive contract on Reactive Lasna that hears `FeeUpdated` and, through a callback, marks the pool as
   narrowed on a `PoolGuard` contract on Base Sepolia. Anyone reads the mark with `statusOf(pool)`. *(`reflex/`)*

Marks only tighten, and nothing here moves anyone's money.

## The test pool (Base Sepolia, chain 84532)

| What | Address / value |
| --- | --- |
| Hook `DynamicFeeHook` | [`0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000`](https://sepolia.basescan.org/address/0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000) |
| Pool id | `0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4` |
| Pool key | ETH (`0x0`) / [USDC](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) · fee `0x800000` (dynamic) · tick spacing 10 · hook above |
| Start | tick −202230 ≈ 1650.83 USDC per ETH · LP fee 500 (0.05%) |
| Uniswap v4 ([official list](https://docs.uniswap.org/contracts/v4/deployments)) | PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` · StateView `0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4` · V4Quoter `0x5e6B8B8AFA7e5CEF6C09dd2A67aBA9FB12C75623` · PositionManager `0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80` |

Machine-readable copy: [`deployments/base-sepolia.json`](deployments/base-sepolia.json).

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
| `script/Reopen.s.sol` | The owner reopens the test pool | Base Sepolia |
| `scripts/measure.mjs` | Changes the fee, waits for the mark, records the three transactions, reopens, repeats | both |
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
| `SetFee.s.sol` | Changes the LP fee (1 transaction, one `FeeUpdated`) | `NEW_FEE` (500 = 0.05%, 100000 = 10%) |
| `Seed.s.sol` | Adds another ETH-only position at the current price | `SEED_WEI` |
| `Quote.s.sol` | Read-only: pool state and a USDC → ETH quote | `USDC_IN` (default 10 USDC) |
| `Status.s.sol` | Read-only: the deployer's balances | — |
| `BridgeToBaseSepolia.s.sol` | Moves test ETH from Ethereum Sepolia through Base's official bridge | `BRIDGE_WEI` |

The hook address depends on the exact creation code (`bytecode_hash = "none"` keeps it the same on every machine),
the owner and the initial fee. Testnet only.
