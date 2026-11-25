import {
  decodeAbiParameters,
  encodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, GIWA_SEPOLIA, targets, type SwapChain } from "./chains";
import { fmtEth, fmtUsdc, short } from "./format";
import { buildPlan, type Quote, type SwapPlan, type WalletState } from "./plan";
import type { Simulation } from "./read";
import { cardView, confirmedApprovals, NO_CONTEST_CHECK, type CardState } from "./view";
import { canSign } from "@/components/sign-card/sign-card";

/*
  The card must say what the wallet signs. These tests decode every
  transaction of a plan on their own (ABIs written out here, not shared with
  the app's decoder) and check that the card's amounts, recipient and
  approvals are those values, and that a plan whose bytes say anything else
  cannot be signed.
*/

const ACCOUNT: Address = getAddress("0x1111111111111111111111111111111111111111");
const NOW = 1_795_700_000;
const AMOUNT = 10_000_000n; // 10 USDC

// Independent ABIs for decoding.
const ERC20 = parseAbi(["function approve(address spender, uint256 amount)"]);
const PERMIT2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const UR = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const SR02 = parseAbi([
  "function multicall(uint256 deadline, bytes[] data)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
]);

type Signed = { approvals: { spender: Address; amount: bigint; via: "erc20" | "permit2"; expiration?: number }[]; amountIn: bigint; minOut: bigint; recipient: Address; deadline: bigint };

function decodeIndependently(chain: SwapChain, plan: SwapPlan): Signed {
  const out: Signed = { approvals: [], amountIn: -1n, minOut: -1n, recipient: "0x0000000000000000000000000000000000000000", deadline: -1n };
  for (const { tx } of plan.steps) {
    expect(tx.value).toBe(0n);
    expect(targets(chain).some((t) => isAddressEqual(t, tx.to))).toBe(true);
    if (isAddressEqual(tx.to, chain.usdc.address)) {
      const { args } = decodeFunctionData({ abi: ERC20, data: tx.data });
      out.approvals.push({ spender: args[0], amount: args[1], via: "erc20" });
    } else if (chain.dex === "uniswap-v4" && isAddressEqual(tx.to, chain.permit2)) {
      const { args } = decodeFunctionData({ abi: PERMIT2, data: tx.data });
      expect(isAddressEqual(args[0], chain.usdc.address)).toBe(true);
      out.approvals.push({ spender: args[1], amount: args[2], via: "permit2", expiration: args[3] });
    } else if (chain.dex === "uniswap-v4") {
      const { args } = decodeFunctionData({ abi: UR, data: tx.data });
      expect(args[0]).toBe("0x10"); // V4_SWAP
      const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), args[1][0]);
      expect(actions).toBe("0x060c0e"); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE
      const [swap] = decodeAbiParameters(
        parseAbiParameters("((address, address, uint24, int24, address), bool, uint128, uint128, bytes)"),
        params[0],
      );
      const [take] = [decodeAbiParameters(parseAbiParameters("address, address, uint256"), params[2])];
      expect(swap[1]).toBe(false); // USDC (currency1) in, ETH (currency0) out
      expect(take[0]).toBe("0x0000000000000000000000000000000000000000"); // ETH
      out.amountIn = swap[2];
      out.minOut = swap[3];
      out.recipient = getAddress(take[1]);
      out.deadline = args[2];
    } else {
      const { args } = decodeFunctionData({ abi: SR02, data: tx.data });
      const [deadline, inner] = args as unknown as [bigint, Hex[]];
      const swap = decodeFunctionData({ abi: SR02, data: inner[0] });
      const unwrap = decodeFunctionData({ abi: SR02, data: inner[1] });
      expect(swap.functionName).toBe("exactInputSingle");
      expect(unwrap.functionName).toBe("unwrapWETH9");
      const p = (swap.args as unknown as [{ amountIn: bigint; amountOutMinimum: bigint; tokenIn: Address; tokenOut: Address }])[0];
      expect(isAddressEqual(p.tokenIn, chain.usdc.address)).toBe(true);
      const [unwrapMin, recipient] = unwrap.args as unknown as [bigint, Address];
      out.amountIn = p.amountIn;
      out.minOut = unwrapMin;
      expect(p.amountOutMinimum).toBe(unwrapMin);
      out.recipient = getAddress(recipient);
      out.deadline = deadline;
    }
  }
  return out;
}

const quoteFor = (chain: SwapChain, expectedOut: bigint, pool: Hex | undefined = chain.dex === "uniswap-v4" ? chain.pools[0].id : undefined): Quote => ({
  chainId: chain.id,
  amountIn: AMOUNT,
  expectedOut,
  block: 100n,
  at: NOW * 1000,
  lpFee: chain.id === BASE_SEPOLIA.id ? 500 : 3000,
  pool,
});
const freshWallet: WalletState = { account: ACCOUNT, usdcBalance: 20_000_000n, erc20Allowance: 0n, permit2: { amount: 0n, expiration: 0 } };

function passed(plan: SwapPlan): Simulation {
  return { ok: true, planId: plan.id, block: 101n, ethDelta: plan.expectedOut, usdcDelta: -plan.amountIn, gas: 250_000n, gasPrice: 6_000_000n };
}

function stateFor(chain: SwapChain, plan: SwapPlan, simulation: Simulation | null = passed(plan)): CardState {
  return {
    chain,
    amountIn: AMOUNT,
    quote: plan.quote,
    quoteError: null,
    account: ACCOUNT,
    balances: { usdc: 20_000_000n, eth: 10n ** 16n },
    plan,
    simulation,
    phase: { kind: "idle" },
    gate: NO_CONTEST_CHECK,
  };
}

describe.each([
  ["Base Sepolia (Uniswap v4)", BASE_SEPOLIA, 6_045_433_325_479_375n],
  ["GIWA Sepolia (Uniswap v3)", GIWA_SEPOLIA, 3_835_057_891_295_149n],
] as const)("%s", (_name, chain, expectedOut) => {
  const plan = buildPlan({ chain, quote: quoteFor(chain, expectedOut), wallet: freshWallet, nowSec: NOW });
  const signed = decodeIndependently(chain, plan);
  const view = cardView(stateFor(chain, plan));

  it("sends exactly the card's amount, to the card's minimum, at the signer's address", () => {
    expect(signed.amountIn).toBe(AMOUNT);
    expect(view.sends?.amount).toBe(`−${fmtUsdc(signed.amountIn)}`);
    expect(view.sends?.amount).toBe("−10");
    expect(view.receives?.note).toBe(`min ${fmtEth(signed.minOut)}`);
    expect(signed.minOut).toBe((expectedOut * 9950n) / 10_000n);
    expect(signed.recipient).toBe(ACCOUNT);
    expect(view.check.items).toContain("goes to your address");
    expect(Number(signed.deadline)).toBe(NOW + 15 * 60);
  });

  it("approves this amount only, to the contract the swap uses", () => {
    const spenders = chain.dex === "uniswap-v4" ? [chain.permit2, chain.universalRouter] : [chain.swapRouter02];
    expect(signed.approvals.map((a) => a.spender)).toEqual(spenders);
    for (const a of signed.approvals) {
      expect(a.amount).toBe(AMOUNT);
      expect(a.amount).not.toBe(maxUint256);
    }
    expect(view.check.items).toContain("approves 10 USDC only");
  });

  it("lists every signed transaction in the check details, decoded from its bytes", () => {
    const rows = Object.fromEntries(view.check.detail ?? []);
    expect(rows["Wallet"]).toBe(short(ACCOUNT));
    const signRows = (view.check.detail ?? []).filter(([k]) => k.startsWith("Sign "));
    expect(signRows).toHaveLength(plan.steps.length);
    signed.approvals.forEach((a, i) => {
      expect(signRows[i][1]).toContain(short(a.spender));
      expect(signRows[i][1]).toContain(`${fmtUsdc(a.amount)} USDC`);
    });
    const swapRow = signRows[signRows.length - 1][1];
    expect(swapRow).toContain(`${fmtUsdc(signed.amountIn)} USDC → at least ${fmtEth(signed.minOut)} ETH to your address ${short(signed.recipient)}`);
    expect(rows["Value"]).toBe("0 ETH in every transaction");
  });

  it("opens the sign gate only for a passed simulation of this very plan", () => {
    expect(view.check.tone).toBe("ok");
    expect(view.simulation).toBe("passed");
    expect(canSign({ ...view, sign: { simulation: view.simulation, onSign: () => {} } })).toBe(true);
    expect(cardView(stateFor(chain, plan, null)).simulation).toBe("pending");
    expect(cardView(stateFor(chain, plan, { ...passed(plan), planId: "0xdead" })).simulation).toBe("pending");
    const failed = cardView(stateFor(chain, plan, { ok: false, planId: plan.id, block: 1n, reason: "Step 2 of 2 (swap) would revert" }));
    expect(failed.simulation).toBe("failed");
    expect(failed.check.tone).toBe("stop");
    const held = cardView({ ...stateFor(chain, plan), gate: { state: "hold", title: "Pool held", items: "· its fee changed" } });
    expect(held.check.tone).toBe("stop");
    expect(canSign({ ...held, sign: { simulation: held.simulation, onSign: () => {} } })).toBe(false);
  });

  it("keeps the button off while a contest check is still running (fail-closed)", () => {
    const pending = cardView({ ...stateFor(chain, plan), gate: { state: "pending", label: "the circuit to agree with the server" } });
    expect(pending.check).toMatchObject({ tone: "plain", title: "Waiting for the circuit to agree with the server" });
    expect(canSign({ ...pending, sign: { simulation: pending.simulation, onSign: () => {} } })).toBe(false);
  });

  it("blocks new signatures while a sent transaction is unconfirmed", () => {
    const v = cardView({ ...stateFor(chain, plan), phase: { kind: "unconfirmed", step: plan.steps.length - 1, total: plan.steps.length, hash: `0x${"cd".repeat(32)}`, nonce: 7 } });
    expect(v.check).toMatchObject({ tone: "stop", title: "Sent, not confirmed yet" });
    expect(v.busy).toBe(true);
    expect(canSign({ ...v, sign: { simulation: v.simulation, busy: v.busy, onSign: () => {} } })).toBe(false);
  });

  it("names what stays approved when signing stops after the approvals", () => {
    const lines = confirmedApprovals(chain, plan, plan.steps.length - 1);
    expect(lines).toHaveLength(signed.approvals.length);
    signed.approvals.forEach((a, i) => {
      expect(lines[i]).toContain(short(a.spender));
      expect(lines[i]).toContain(`${fmtUsdc(a.amount)} USDC`);
    });
    expect(confirmedApprovals(chain, plan, 0)).toEqual([]);
  });

  it("skips approvals the wallet already gave and never raises them", () => {
    const enough: WalletState = { ...freshWallet, erc20Allowance: AMOUNT, permit2: { amount: AMOUNT, expiration: NOW + 3600 } };
    const p = buildPlan({ chain, quote: quoteFor(chain, expectedOut), wallet: enough, nowSec: NOW });
    expect(p.steps.map((s) => s.kind)).toEqual(["swap"]);
    expect(cardView(stateFor(chain, p)).check.items).toContain("no new approval");
  });

  it("refuses a plan whose swap pays someone else", () => {
    const thief = getAddress("0x2222222222222222222222222222222222222222");
    const swapStep = plan.steps[plan.steps.length - 1];
    const lowered = ACCOUNT.slice(2).toLowerCase();
    const tampered: SwapPlan = {
      ...plan,
      steps: [...plan.steps.slice(0, -1), { ...swapStep, tx: { ...swapStep.tx, data: swapStep.tx.data.replace(lowered, thief.slice(2).toLowerCase()) as Hex } }],
    };
    expect(tampered.steps[tampered.steps.length - 1].tx.data).not.toBe(swapStep.tx.data);
    const v = cardView(stateFor(chain, tampered));
    expect(v.check.tone).toBe("stop");
    expect(v.check.title).toBe("These transactions do not match the card");
    expect(v.check.items).toContain(`pays ${short(thief)}`);
    // Even a passing simulation cannot turn the button on: the check is stop and nothing is shown as received.
    expect(v.simulation).toBe("passed");
    expect(v.receives).toBeUndefined();
    expect(canSign({ ...v, sign: { simulation: v.simulation, onSign: () => {} } })).toBe(false);
  });

  it("refuses an unlimited approval slipped into the plan", () => {
    const first = plan.steps[0];
    const spender = chain.dex === "uniswap-v4" ? chain.permit2 : chain.swapRouter02;
    const tampered: SwapPlan = {
      ...plan,
      steps: [{ ...first, tx: { ...first.tx, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, maxUint256] }) } }, ...plan.steps.slice(1)],
    };
    const v = cardView(stateFor(chain, tampered));
    expect(v.check.tone).toBe("stop");
    expect(v.sends?.amount).toBe("−10");
  });

  it("refuses a swap sent to another contract or carrying ETH, even with a passing simulation", () => {
    const swapStep = plan.steps[plan.steps.length - 1];
    const other = getAddress("0x3333333333333333333333333333333333333333");
    for (const tx of [{ ...swapStep.tx, to: other }, { ...swapStep.tx, value: 10n ** 15n }]) {
      const tampered: SwapPlan = { ...plan, steps: [...plan.steps.slice(0, -1), { ...swapStep, tx }] };
      const v = cardView(stateFor(chain, tampered));
      expect(v.check.tone).toBe("stop");
      expect(canSign({ ...v, sign: { simulation: v.simulation, onSign: () => {} } })).toBe(false);
    }
  });

  it("keeps the previous plan on screen while the next is simulated, with the button off", () => {
    const v = cardView({ ...stateFor(chain, plan), stale: true });
    expect(v.check.tone).toBe("ok");
    expect(v.receives?.note).toBe(`min ${fmtEth(signed.minOut)}`);
    expect(v.simulation).toBe("pending");
    expect(canSign({ ...v, sign: { simulation: v.simulation, onSign: () => {} } })).toBe(false);
  });

  it("says why when the plan cannot be prepared", () => {
    const v = cardView({ ...stateFor(chain, plan), plan: null, simulation: null, prepError: "could not read the wallet: HTTP 429" });
    expect(v.check).toMatchObject({ tone: "stop", title: "Could not prepare the transactions" });
    expect(v.check.items).toContain("HTTP 429");
  });
});

describe("Permit2 allowance window", () => {
  const plan = buildPlan({ chain: BASE_SEPOLIA, quote: quoteFor(BASE_SEPOLIA, 6_000_000_000_000_000n), wallet: freshWallet, nowSec: NOW });

  // The fifth forged plan: the allowance may not outlive the swap by more than 30 minutes.
  it("refuses a Permit2 allowance that lasts long past the swap", () => {
    const i = plan.steps.findIndex((s) => s.kind === "permit2-approve");
    const longLived = encodeFunctionData({ abi: PERMIT2, functionName: "approve", args: [BASE_SEPOLIA.usdc.address, BASE_SEPOLIA.universalRouter, AMOUNT, plan.deadline + 365 * 24 * 3600] });
    const tampered: SwapPlan = { ...plan, steps: plan.steps.map((s, j) => (j === i ? { ...s, tx: { ...s.tx, data: longLived } } : s)) };
    const v = cardView(stateFor(BASE_SEPOLIA, tampered));
    expect(v.check.tone).toBe("stop");
    expect(v.check.items).toContain("Permit2 allowance lasts until");
    expect(canSign({ ...v, sign: { simulation: v.simulation, onSign: () => {} } })).toBe(false);
  });

  it("shows the allowance and deadline with their date", () => {
    const rows = (cardView(stateFor(BASE_SEPOLIA, plan)).check.detail ?? []).map(([, v]) => v);
    expect(rows.find((r) => r.startsWith("Permit2.approve"))).toMatch(/until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u);
    expect(rows.find((r) => r.startsWith("Universal Router"))).toMatch(/by \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u);
  });
});

describe("buildPlan", () => {
  it("renews a Permit2 allowance that would expire before the deadline, for this amount only", () => {
    const wallet: WalletState = { ...freshWallet, erc20Allowance: AMOUNT, permit2: { amount: AMOUNT, expiration: NOW + 60 } };
    const plan = buildPlan({ chain: BASE_SEPOLIA, quote: quoteFor(BASE_SEPOLIA, 6_000_000_000_000_000n), wallet, nowSec: NOW });
    expect(plan.steps.map((s) => s.kind)).toEqual(["permit2-approve", "swap"]);
    const signed = decodeIndependently(BASE_SEPOLIA, plan);
    expect(signed.approvals[0]).toEqual({ spender: BASE_SEPOLIA.universalRouter, amount: AMOUNT, via: "permit2", expiration: NOW + 30 * 60 });
  });

  it("refuses a quote for another chain or one that rounds the minimum to zero", () => {
    expect(() => buildPlan({ chain: GIWA_SEPOLIA, quote: quoteFor(BASE_SEPOLIA, 10n ** 15n), wallet: freshWallet, nowSec: NOW })).toThrow("another chain");
    expect(() => buildPlan({ chain: BASE_SEPOLIA, quote: quoteFor(BASE_SEPOLIA, 1n), wallet: freshWallet, nowSec: NOW })).toThrow("rounds to zero");
  });

  it("shows the quote's own preview before a wallet is connected", () => {
    const quote = quoteFor(BASE_SEPOLIA, 6_045_433_325_479_375n);
    const v = cardView({ chain: BASE_SEPOLIA, amountIn: AMOUNT, quote, quoteError: null, account: null, balances: null, plan: null, simulation: null, phase: { kind: "idle" }, gate: NO_CONTEST_CHECK });
    expect(v.sends?.amount).toBe("−10");
    expect(v.receives?.amount).toBe("+0.00604543");
    expect(v.simulation).toBe("none");
    expect(v.check.tone).toBe("plain");
  });

  it("stops when the wallet holds less USDC than the swap", () => {
    const plan = buildPlan({ chain: GIWA_SEPOLIA, quote: quoteFor(GIWA_SEPOLIA, 3_835_057_891_295_149n), wallet: { ...freshWallet, usdcBalance: 0n }, nowSec: NOW });
    const v = cardView({ ...stateFor(GIWA_SEPOLIA, plan), balances: { usdc: 0n, eth: 10n ** 16n } });
    expect(v.check.tone).toBe("stop");
    expect(v.check.title).toBe("Not enough USDC (Mock)");
  });
});

describe("Base Sepolia pools", () => {
  const [A, B] = BASE_SEPOLIA.pools;
  const SWAP_PARAMS = parseAbiParameters("((address, address, uint24, int24, address), bool, uint128, uint128, bytes)");
  const INPUT = parseAbiParameters("bytes, bytes[]");
  const planFor = (pool: Hex) => buildPlan({ chain: BASE_SEPOLIA, quote: quoteFor(BASE_SEPOLIA, 6_000_000_000_000_000n, pool), wallet: freshWallet, nowSec: NOW });

  function swapOf(plan: SwapPlan) {
    const { args } = decodeFunctionData({ abi: UR, data: plan.steps.at(-1)!.tx.data });
    const [actions, params] = decodeAbiParameters(INPUT, args[1][0]);
    const [swap] = decodeAbiParameters(SWAP_PARAMS, params[0]);
    return { args, actions, params, swap };
  }

  it("swaps through the pool the quote is for, and the route line names that pool", () => {
    for (const pool of [A, B]) {
      const plan = planFor(pool.id);
      const [c0, c1, fee, spacing, hooks] = swapOf(plan).swap[0];
      expect([c0, c1, fee, spacing]).toEqual([pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing]);
      expect(isAddressEqual(hooks, pool.key.hooks)).toBe(true);
      const v = cardView(stateFor(BASE_SEPOLIA, plan));
      expect(v.decoded?.swap.pool).toBe(pool.id);
      expect(v.route.label).toBe(`Uniswap v4 · ETH/USDC ${pool.label}`);
      expect(v.check.tone).toBe("ok");
    }
    expect(A.key.tickSpacing).not.toBe(B.key.tickSpacing);
  });

  it("refuses a quote that names no listed pool", () => {
    expect(() => planFor(`0x${"22".repeat(32)}`)).toThrow("not listed");
    const noPool = { ...quoteFor(BASE_SEPOLIA, 6_000_000_000_000_000n), pool: undefined };
    expect(() => buildPlan({ chain: BASE_SEPOLIA, quote: noPool, wallet: freshWallet, nowSec: NOW })).toThrow("not listed");
  });

  // The sixth forged plan: the same swap through a pool nobody listed (pool A's key with tick spacing 30).
  it("stops a plan whose swap goes through an unlisted pool", () => {
    const plan = planFor(A.id);
    const { args, actions, params, swap } = swapOf(plan);
    const [c0, c1, fee, , hooks] = swap[0];
    const forged = encodeAbiParameters(SWAP_PARAMS, [[[c0, c1, fee, 30, hooks], swap[1], swap[2], swap[3], swap[4]]]);
    const input = encodeAbiParameters(INPUT, [actions, [forged, params[1], params[2]]]);
    const data = encodeFunctionData({ abi: UR, functionName: "execute", args: [args[0], [input], args[2]] });
    const tampered: SwapPlan = { ...plan, steps: plan.steps.map((s, i) => (i === plan.steps.length - 1 ? { ...s, tx: { ...s.tx, data } } : s)) };
    const v = cardView(stateFor(BASE_SEPOLIA, tampered));
    expect(v.check.tone).toBe("stop");
    expect(v.check.items).toContain("spacing 30");
    expect(v.check.items).toContain("is not listed");
    expect(canSign({ ...v, sign: { simulation: v.simulation, onSign: () => {} } })).toBe(false);
  });

  it("names no route when there is no quote to show", () => {
    const base: CardState = { chain: BASE_SEPOLIA, amountIn: AMOUNT, quote: null, quoteError: null, account: null, balances: null, plan: null, simulation: null, phase: { kind: "idle" }, gate: NO_CONTEST_CHECK };
    expect(cardView(base).route.label).toBeUndefined(); // still loading
    const none = cardView({ ...base, quoteError: "every listed pool is left out" });
    expect(none.route.label).toBe("None");
    expect(none.receives).toEqual({ amount: "—", token: "" });
    expect(canSign({ ...none, sign: { simulation: none.simulation, onSign: () => {} } })).toBe(false);
    expect(cardView({ ...base, quote: quoteFor(BASE_SEPOLIA, 6_000_000_000_000_000n, B.id) }).route.label).toBe(`Uniswap v4 · ETH/USDC ${B.label}`);
  });
});

describe("blocked card titles", () => {
  const plan = buildPlan({ chain: BASE_SEPOLIA, quote: quoteFor(BASE_SEPOLIA, 6_000_000_000_000_000n), wallet: freshWallet, nowSec: NOW });

  it("says a stop before the next signature stopped before signing", () => {
    const v = cardView({ ...stateFor(BASE_SEPOLIA, plan), phase: { kind: "blocked", reason: "declined in your wallet", at: NOW * 1000 } });
    expect(v.check).toMatchObject({ tone: "stop", title: "Stopped before signing", items: "· declined in your wallet" });
  });

  // A released transaction was sent; its nonce was used by another. Saying "before signing" would be wrong.
  it("says a released transaction was released and the card needs a reload", () => {
    const v = cardView({ ...stateFor(BASE_SEPOLIA, plan), phase: { kind: "blocked", reason: "nonce 12 was used by another transaction" } });
    expect(v.check).toMatchObject({ tone: "stop", title: "Released — reload to sign again" });
    expect(canSign({ ...v, sign: { simulation: v.simulation, onSign: () => {} } })).toBe(false);
  });
});
