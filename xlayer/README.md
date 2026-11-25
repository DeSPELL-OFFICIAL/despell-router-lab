# X Layer: the router's pool judgment as a NAND circuit

The DeSpell router watches every pool it might route a trade through. When something about a pool changes, code tightens it at once; an AI team reviews it; and the pool opens again only when test trades pass. This folder takes the rules that make those calls and builds them as one [TapeOut](https://tapemkt.com/xlayer) NAND circuit, so that anyone can feed the same facts into the circuit on X Layer with `eval(circuitId, inputs)` and get the same judgment the server made.

| | |
| --- | --- |
| Inputs | 27 bits: the pool's stage, the ten changes the patrol can detect, operator block, the AI decision and its conditions, family, four probe facts, card age, amount |
| Outputs | 5 bits: the stage the patrol writes next (3) and the lane a trade gets right now (2) |
| Size | **157 NAND**, 1,099 bytes of netlist ([`circuit/pool-judgment.json`](circuit/pool-judgment.json)) |
| Checked | Equal to the rule function on **all 134,217,728 input combinations** (2^27), and the rule function equal to the server's own code on every combination its functions take |
| Cost to tape out | **0.017 OKB** in fees (0.0013 + 157 × 0.0001), **0.01766 OKB** with the transistor mint's protocol fee |

The circuit is a second, public copy of the judgment. The server stays the one that decides; the app compares the two and holds a card when they differ. TapeOut's netlist format is a draft and its contracts are not audited, so a circuit result is supporting evidence, never the only check.

## Folder

| Path | What it is |
| --- | --- |
| `src/rule.ts` | The rules as plain functions, each naming the server function it restates |
| `src/measure.ts` | Turning readings into input bits: the loss, age and cap comparisons that stay outside the circuit |
| `src/bits.ts` | Pin layout, and packing for `eval` |
| `src/circuit.ts` | The same rules written as Boolean equations, built into NAND gates |
| `src/netlist.ts` | NAND builder, TapeOut byte format, evaluators (one vector, or 32 at a time) |
| `src/cost.ts` | OKB fees |
| `src/onchain.ts` | Reads a TapeOut processor over JSON-RPC (`eval`, `netlist`, `circuitInfo`, fees) and gives the circuit's judgment for an input (`judgeOnChain`) |
| `src/samples.ts` | Named and pseudo-random sample vectors with the rule's answers, for checking `eval` after a tape-out |
| `scripts/build-circuit.ts` | Builds the netlist, checks it on every input, writes `circuit/pool-judgment.json` and `circuit/pool-judgment-samples.json` |
| `scripts/check-onchain.ts` | Read-only X Layer checks: fees today, and the byte format against circuits already on chain |
| `scripts/quote-bem.ts` | Fetches and checks a LI.FI quote for the OKB → BEM swap the tape-out needs (a read; nothing is sent) |
| `scripts/find-processor.ts` | Finds the DeSpell processor a wallet made and records its address outside the repository, so later runs name it |
| `scripts/check-tapeout.ts` | After the tape-out: reads the circuit back from X Layer and compares `eval` with the rule function on every sample |
| `contracts/` | Foundry: the TapeOut interfaces, the tape-out script, a unit test, and fork tests against X Layer mainnet |

This folder is one package of the repository's pnpm workspace, so `pnpm install` runs at the repository root and the root lockfile pins its two dev dependencies (TypeScript and Node types). Nothing else is needed: the code runs on Node 24 with its built-in TypeScript support.

```bash
pnpm install              # at the repository root
pnpm test                 # 37 tests, including the 2^27 comparison (about 16 s on 12 threads)
pnpm typecheck
pnpm build:circuit        # rebuild circuit/pool-judgment.json and its samples
pnpm check:circuit        # fail if the committed netlist or samples are out of date
node scripts/check-onchain.ts

cd contracts
./scripts/install-deps.sh               # forge-std at a pinned commit
forge test                              # unit tests
FOUNDRY_PROFILE=fork forge test -vv     # the whole tape-out on a fork of X Layer mainnet (sends nothing)
```

## Input pins

`eval` takes the pins packed little end first: pin *i* is bit *i* % 8 of byte ⌊*i* / 8⌋, so 27 pins are 4 bytes.

| Pin | Name | 1 means | Server rule |
| --- | --- | --- | --- |
| 0–2 | `stage` | Stage code on the card: 0 blocked, 1 unknown, 2 restricted, 3 probation, 4 trusted (5–7: not a stage) | the server's stage rank (`POOL_TRUST_RANK`) |
| 3 | `code_changed` | The pool's code changed | `diffPoolCard` |
| 4 | `token_code_changed` | A token's code or proxy implementation changed | 〃 |
| 5 | `implementation_changed` | The pool's proxy implementation changed | 〃 |
| 6 | `owner_changed` | The pool's owner changed | 〃 |
| 7 | `paused` | The pool is paused now | 〃 |
| 8 | `fee_changed` | The pool's fee changed | 〃 |
| 9 | `reserve_below_band` | A reserve fell below its usual band or fixed floor | 〃 |
| 10 | `round_trip_loss_up` | The virtual round trip loss rose | 〃 |
| 11 | `sell_reverted` | A test sell reverted | 〃 |
| 12 | `stale` | The card is old, or a field could not be read | 〃 |
| 13 | `operator_blocked` | An operator block covers the pool, a token, the deployer or the code family | `isOperatorBlocked` |
| 14–15 | `decision` | AI decision applied this step: 0 none, 1 allow, 2 restrict, 3 block | `finalizePatrolVerdict` |
| 16 | `full_review` | The judgment came from a full review, not a partial one | `patrolTrustVerdict` |
| 17 | `admin_handle_restrict` | The restrict met every condition of the admin handle path | `finalizePatrolVerdict` |
| 18 | `token_permissions_clear` | Both tokens read false on blacklist, mint, owner-modify and transfer-pause | `poolTokenPermissionStatus` |
| 19–20 | `family` | 0 ammora_curve, 1 uniswap_v3, 2 pancake_infinity_cl (3: not a family) | `poolFamilyOpenable` |
| 21 | `loss_under_reflex_line` | Round trip loss measured and under 300bp | `probeFactsPass` |
| 22 | `hidden_loss_within_open_limit` | Loss minus the pool's own round trip fee measured and at most 100bp | `poolOpeningHiddenLossBps` |
| 23 | `sell_not_reverted` | The probe sold back and the sell did not revert | `probeFactsPass` |
| 24 | `code_hash_matches` | Code fingerprints read now match the card | `probeFactsPass` |
| 25 | `card_fresh` | Card checked within 26 h and at most 5 min ahead of now | `poolLane` |
| 26 | `amount_within_cap` | Amount and base cap positive, amount ≤ base cap × multiplier held to the stage ceiling | `poolLane`, `poolCapRaw`, `maxCapFor` |

A fact that was not measured is 0. `src/measure.ts` makes pins 18 and 21–26 from the raw readings, the same way the server does.

## Output pins

| Pin | Name | Value |
| --- | --- | --- |
| 0–2 | `next_stage` | Stage code the patrol writes after this step (always 0–4) |
| 3–4 | `lane` | 0 fast, 1 standard, 2 deep, 3 closed |

## The rules

Each row is one rule, the function in `rule.ts` that states it, and the server function it comes from.

| Rule | `rule.ts` | Server |
| --- | --- | --- |
| A code change, token code change, implementation change or reverted sell blocks; an owner, fee, reserve or round trip change restricts; pause and stale leave the stage alone | `REFLEX_BY_CHANGE`, `reflexStage` | `reflexFor` |
| The reflex only tightens: the stage becomes the lower of the two (a first-seen pool hit by a restrict stays unknown) | `applyReflex` | `applyReflex` |
| The AI decision applies to the ledger after this step's reflex | `patrolStage` | `poolLedgerAfterReflex`, then `patrolTrustStep` |
| block proposes blocked; restrict never proposes above the stage, except the admin handle path on a first-seen pool, which proposes restricted; allow proposes probation (trusted stays trusted), and above the current stage only from a full review with clear token permissions | `proposedStage` | `poolTrustProposal` |
| Moving down is always accepted. Moving up needs an approved family and every probe fact passing, with clear token permissions; otherwise the stage stays. Trusted is reached only from probation | `nextStage`, `probePass`, `familyOpenable` | `nextTrustState`, `probeFactsPass`, `poolFamilyOpenable` |
| A stage outside the closed list opens nothing and is lowered to blocked | `patrolStage` | `nextTrustState` |
| An operator block does not change the stage; it closes the lane | `patrolStage`, `tradeLane` | the operator block list stands beside the stage; `poolLane` |
| Lane, first match wins: operator block, pause, blocked card or reverted sell → closed; code change → deep; unknown, broken stage or watch-only family → deep; restrict reflex, restricted card, stale, old card or amount over the cap → standard; otherwise fast | `tradeLane` | `poolLane` |

One consequence worth seeing in the circuit: in a patrol step, `trusted` only ever stays `trusted`. The AI's `allow` proposes probation at most, so no single judgment lifts a pool to trusted.

### As equations

`circuit.ts` writes the same rules a second time, as gates. With one wire per stage after the reflex (`aB`, `aU`, `aR`, `aP`, `aT`), `opens = familyOpenable ∧ probePass` and `fullClear = full_review ∧ token_permissions_clear`:

```
reflexBlock    = code ∨ token_code ∨ implementation ∨ sell_reverted
reflexRestrict = owner ∨ fee ∨ reserve ∨ round_trip_loss_up
aB = blocked ∨ reflexBlock        aU = unknown ∧ ¬reflexBlock
aR = ¬reflexBlock ∧ (restricted ∨ reflexRestrict ∧ (probation ∨ trusted))
aP = probation ∧ ¬reflexBlock ∧ ¬reflexRestrict      aT = trusted ∧ ¬reflexBlock ∧ ¬reflexRestrict

handlePath  = restrict ∧ admin_handle_restrict ∧ fullClear ∧ aU
nextTrusted = aT ∧ (none ∨ allow)
nextProb    = allow ∧ fullClear ∧ opens ∧ (aB ∨ aU ∨ aR)  ∨  aP ∧ (none ∨ allow)
nextRestr   = none ∧ aR  ∨  restrict ∧ ¬handlePath ∧ (aR ∨ aP ∨ aT)  ∨  handlePath ∧ opens  ∨  allow ∧ aR ∧ ¬(fullClear ∧ opens)
nextUnknown = aU ∧ (none ∨ restrict ∧ ¬(handlePath ∧ opens) ∨ allow ∧ ¬(fullClear ∧ opens))
next_stage  = 0 if the stage code is 5–7, else the code of whichever wire is on (blocked, code 0, when none is)

closed   = operator_blocked ∨ paused ∨ blocked ∨ sell_reverted
deep     = code ∨ token_code ∨ implementation ∨ unknown ∨ broken ∨ ¬familyOpenable
standard = reflexRestrict ∨ restricted ∨ stale ∨ ¬card_fresh ∨ ¬amount_within_cap
lane     = closed ? 3 : deep ? 2 : standard ? 1 : 0
```

The builder folds constants, removes double negations and makes each distinct NAND once.

## Evidence

**Circuit = rule function, every input.** `pnpm test`, 2026-11-26:

```
✔ the circuit equals the rule function on every input combination
ℹ 134,217,728 of 134,217,728 combinations (2^27), 0 differ, 157 NAND, 12 threads, 8227 ms
✔ the circuit never opens a pool without an AI full review, approved family and passing probe facts
✔ an operator block or a pause always closes the lane
ℹ tests 31 · pass 31 · fail 0
```

**Rule function = server code.** The rule function and `measure.ts` were run against the server's own functions, from the private DeSpell codebase, on the same readings. That script names private code, so it stays outside this repository; its result on 2026-11-26:

| What | Cases | Differ |
| --- | --- | --- |
| Next stage: every combination of the inputs a patrol step takes (stage, ten changes, decision, scope, handle path, token permissions, family, probe readings), through `poolLedgerAfterReflex` then `patrolTrustStep`, for a fresh verdict | 16,777,216 | 0 |
| The same, for a reused judgment (handle bit 0) | 6,291,456 | 0 |
| Lane: every combination of stage, changes, operator block, family, card age and amount, multipliers below, at and above each ceiling | 262,144 | 0 |
| Lane: amounts one under, at and one over the server's own cap, for every stage, origin, multiplier and base cap | 2,640 | 0 |
| Lane for a pool never seen: no card, or a card from another chain | 128 | 0 |

The readings cover each case on purpose: unmeasured, missing, `NaN` and negative values, losses on and around the 100bp and 300bp lines, multipliers such as 0.57 whose float error the server keeps. The script fails unless the readings reach every input vector they can make; for the lane that is 180,224 of 262,144, because at unknown, blocked or a broken stage the cap is 0 and no reading makes `amount_within_cap` 1. The lane never reaches the amount check for those stages, and the 2^27 test covers them on the circuit side.

There is one documented gap, 1,572,864 stage cases that cannot occur: a stored stage outside the closed list with no AI decision. The server keeps that value and the database's check constraint refuses to store it; the circuit says blocked.

One order is read from the server's source instead of run: the reflex first, then the AI judgment on the ledger after the reflex. The server's own tests pin that order.

Breaking a rule on purpose shows the checks catch it: letting `nextStage` open without probe facts makes 5,102,848 circuit inputs and 954,800 server stage cases differ; turning `owner_changed` into a block makes 917,504 circuit inputs, 261,376 stage cases and 1,792 lane cases differ; dropping the blocked card from the circuit's closed lane makes 2,097,152 circuit inputs differ; and an amount check of `<` instead of `<=` in `measure.ts` makes 106 lane cases differ.

**The byte format, on chain.** `node scripts/check-onchain.ts` reads circuits already taped out on the OrderGuard XL processor, evaluates their netlists with `src/netlist.ts` and compares with the contract's own `eval` (view calls, no transaction):

```
TAPEOUT_FEE 0.0013 OKB · mintPrice 0.0001 OKB per NAND · protocolFee 0.00066 OKB per mint · NAND supply 1806/10000 · gas price 20000001 wei
circuit #15: 24 in, 1 out, 108 NAND · local evaluation = on-chain eval on 24/24 vectors (2 different outputs seen)
circuit #18: 19 in, 1 out, 46 NAND · local evaluation = on-chain eval on 24/24 vectors (2 different outputs seen)
circuit #20: 14 in, 5 out, 46 NAND · local evaluation = on-chain eval on 24/24 vectors (6 different outputs seen)
circuit #26: 9 in, 2 out, 27 NAND · local evaluation = on-chain eval on 24/24 vectors (2 different outputs seen)
circuit #27: 17 in, 1 out, 40 NAND · local evaluation = on-chain eval on 24/24 vectors (2 different outputs seen)
```

That confirms the gate encoding (0x00, two big-endian u24 signals), outputs as the last gates in pin order, input packing across several bytes and output packing for several pins.

**Output buffers.** At tape-out the contract adds two buffer NANDs, NAND(x, x) twice, to every output: 10 more gates for this circuit's 5 outputs. They are not part of the netlist: `circuitInfo` reports the netlist's own 157 gates and `netlist(id)` returns the same 1,099 bytes. On a fork of X Layer mainnet (2026-11-26) the tape-out went through holding exactly 157 transistors, so the cost below counts 157. DES-699 confirms the count on the real tape-out before paying (`estimateGas` on the tape-out call).

## Cost

Fees read from X Layer mainnet on 2026-11-26 on the OrderGuard XL processor (`0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355`, transistor contract `0x8e71FC45ff47E5a7bA1ad2960793ebAdD2739D9e`):

| Item | Rate | This circuit |
| --- | --- | --- |
| Tape-out (`TAPEOUT_FEE`) | 0.0013 OKB per circuit | 0.0013 OKB |
| NAND transistors (`mintPrice`) | 0.0001 OKB per NAND | 157 × 0.0001 = 0.0157 OKB |
| **Fees** | | **0.017 OKB** |
| Protocol fee (`protocolFee`) | 0.00066 OKB per mint call | 0.00066 OKB |
| **Total** | | **0.01766 OKB** |
| Gas | 0.02 gwei today | under 0.0001 OKB even at 5,000,000 gas |

At 79.03 USD per OKB (2026-11-25), the total is about 1.40 USD.

A processor made today with the TapeOut factory charges differently. On a fork of X Layer mainnet (2026-11-26), making one cost 0.1 BEM (the factory's fee token) and minting 157 NAND at the lowest price cost 0.01000157 BEM; the tape-out fee stayed 0.0013 OKB. That is the way this circuit is taped out; see [Taping out](#taping-out).

## Taping out

The circuit goes on a DeSpell processor of its own, so the processor address in the submission is ours. `contracts/script/TapeOut.s.sol` does it from one wallet in steps that can each be run again safely:

| Step | `--sig` | Transactions | Pays |
| --- | --- | --- | --- |
| Read where things stand | `status()` | none | |
| Swap OKB for the BEM the next steps need, through a LI.FI quote (`scripts/quote-bem.ts`) | `swapForBem()` | 1 | about 0.0122 OKB |
| Make the DeSpell processor with the TapeOut factory | `createProcessor()` | 2 (exact BEM approval, `createCPU`) | 0.1 BEM |
| Buy 157 NAND transistors and tape the circuit out, then check `eval` on 64 sample vectors against the rule function | `tapeOutCircuit()` | 3 (exact BEM approval, `mint`, `tapeout`) | 0.01000157 BEM and 0.0013 OKB |

Before the swap the script checks the quote again: the wallet pays, BEM comes out, at most 0.025 OKB goes in, the LI.FI Diamond is the contract called, and the quote is at most 5 minutes old. It reads who receives and the minimum received from the swap calldata itself (words 3 and 4 of LI.FI's native-in swap functions), not only from the quote's fields: on the fork, a quote whose calldata alone pays another address, or alone lowers the minimum, is refused. `tapeOutCircuit()` finds the processor on chain by its creator, after it exists, so no transaction is aimed at an address that only existed in a simulation. Once `scripts/find-processor.ts` has recorded the address, later runs pass it as `DESPELL_PROCESSOR` and the script checks it is ours instead of searching. A step that is already done is skipped, and every approval is used up (the fork test checks both allowances end at 0).

After the tape-out, `node scripts/check-tapeout.ts --processor <address>` finds the circuit by its netlist, reads it back and asks X Layer's `eval` for each of the 64 samples, one line per sample, and fails on any difference from the rule function. A server asks the chain the same way:

```ts
import { judgeOnChain, XLayerReader } from "./src/onchain.ts";

const judgment = await judgeOnChain(new XLayerReader(), processor, circuitId, input); // { stage, lane }
```

On a fork of X Layer mainnet (2026-11-26) the whole run from OKB only went through: the swap bought 0.1240 BEM for 0.0121 OKB, the processor was made, the circuit taped out as circuit 1, and `eval` matched the rule function on all 64 samples. In all it spent about 0.0134 OKB plus gas (the five tape-out transactions were estimated at 2.52 million gas, 0.0001 OKB at 0.04 gwei; the swap is one more), about 1.1 USD.

## What the circuit leaves out

- **Cap multipliers.** The stage ceilings are fixed (`unknown 0 · probation 0.32 (registered 0.1) · trusted 1 · restricted 0.1 · blocked 0`), but the multiplier inside a ceiling is a number the AI proposes. It never changes the stage, so the circuit decides stages and lanes; the cap enters only as `amount_within_cap`.
- **Comparisons with numbers.** Loss against 300bp and 100bp, card age against 26 hours, amount against cap: `src/measure.ts`, checked against the server as above.
- **Change detection.** Which of the ten changes a reading shows comes from comparing the card with a fresh reading (`diffPoolCard`). The circuit starts from those bits.
- **The AI team.** Which roles are called, and the code floor rules that bound their answer (`finalizePatrolVerdict`: any security role blocking blocks, a missing security opinion or a failed probe turns allow into restrict). The circuit takes the decision after those rules.
- **When the patrol skips a pool.** A pool whose card is under an operator block is not read at all; a pool whose new reading is blocked, or whose review is deferred, gets the reflex and no AI decision (decision 0). The circuit answers for every input, including combinations the patrol never produces, so whoever builds its inputs puts decision 0 for a pool the patrol skipped.
- **A pool never seen.** It has no card; the circuit takes it as a card at unknown with no changes. The server's lane agrees for every case above. It would differ only for a card-less pool with a reverted sell, which cannot happen: changes come from comparing a reading with a card.
- **Chain.** The patrol only judges GIWA Sepolia (chain 91342). The circuit lives on X Layer; the pools it judges do not.

## Source

The rules come from the DeSpell router, whose code is private. Code was not copied; each rule was written again from the server's behaviour, and every row above names the server function it restates. `ruleVersion` in `circuit/pool-judgment.json` counts rule changes: when the server's rules change, the rules here are written again, checked against the server again, and the circuit is rebuilt as a new circuit with a new id.

The netlist format follows the OrderGuard XL reference implementation ([xm1319/tapemkt](https://github.com/xm1319/tapemkt), `NETLIST-FORMAT.md`) and the on-chain check above.
