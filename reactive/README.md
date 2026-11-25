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
  that is block 63531662. A subscriber treats it as the baseline, not as a change: the Reactive contract (DES-698)
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
