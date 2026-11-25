import { isAddressEqual, type Address, type Hex } from "viem";
import type { Amount, CardCheck, CostItem, SignGate } from "@/components/sign-card/sign-card";
import type { SwapChain } from "./chains";
import { decodePlan, type DecodedPlan, type DecodedStep } from "./decode";
import { fmtEth, fmtFee, fmtTime, fmtUsdc, short } from "./format";
import { minOutFor, type Quote, type SwapPlan } from "./plan";
import type { Simulation } from "./read";

/*
  Turns one swap's state into what the signing card shows. Pure: the same
  state always gives the same card, which is what the tests pin down.

  Once a plan exists, every amount, address and approval on the card is read
  from the plan's decoded transactions (decode.ts), not from the numbers the
  plan was built from.
*/

export type Phase =
  | { kind: "idle" }
  | { kind: "signing"; step: number; total: number; waiting: "simulating" | "wallet" | "chain" }
  | { kind: "blocked"; reason: string }
  | { kind: "done"; hash: Hex; received: bigint | null; block: bigint }
  | { kind: "failed"; hash: Hex | null; reason: string };

/** A contest's reason to stop this card from signing (a held pool, a circuit that disagrees). */
export type Hold = { title: string; items?: string };

export type CardState = {
  chain: SwapChain;
  amountIn: bigint;
  quote: Quote | null;
  quoteError: string | null;
  /** Reading the wallet or building the plan failed (and there is nothing earlier to show). */
  prepError?: string | null;
  /** The plan on screen is the previous one while the next is being built and simulated. */
  stale?: boolean;
  account: Address | null;
  balances: { usdc: bigint; eth: bigint } | null;
  plan: SwapPlan | null;
  /** Latest simulation; only counts when its planId is the plan's id. */
  simulation: Simulation | null;
  phase: Phase;
  hold?: Hold | null;
};

export type CardView = {
  title: string;
  scope: string;
  status: { text: string; accent: boolean };
  sends?: Amount;
  receives?: Amount;
  route: { label: string; note?: string };
  cost: { total: string; items: CostItem[] };
  check: CardCheck;
  signLabel: string;
  simulation: SignGate["simulation"];
  busy: boolean;
  decoded: DecodedPlan | null;
};

const ROUTE_LABEL: Record<SwapChain["dex"], string> = {
  "uniswap-v4": "Uniswap v4 · ETH/USDC test pool",
  "uniswap-v3": "Uniswap v3 · WETH/USDC (Mock)",
};

function contractName(chain: SwapChain, address: Address): string {
  if (isAddressEqual(address, chain.usdc.address)) return "USDC";
  if (chain.dex === "uniswap-v4") {
    if (isAddressEqual(address, chain.permit2)) return "Permit2";
    if (isAddressEqual(address, chain.universalRouter)) return "Universal Router";
  } else if (isAddressEqual(address, chain.swapRouter02)) return "SwapRouter02";
  return "unknown contract";
}

/** One line per signed transaction, in the order the wallet will ask. */
export function describeStep(chain: SwapChain, step: DecodedStep, account: Address): string {
  switch (step.kind) {
    case "approve":
      return `USDC.approve: ${contractName(chain, step.spender)} ${short(step.spender)} may spend ${fmtUsdc(step.amount)} USDC`;
    case "permit2-approve":
      return `Permit2.approve: ${contractName(chain, step.spender)} ${short(step.spender)} may pull ${fmtUsdc(step.amount)} USDC until ${fmtTime(step.expiration)}`;
    case "swap": {
      const to = isAddressEqual(step.recipient, account) ? `your address ${short(step.recipient)}` : `${short(step.recipient)} (not you)`;
      return `${contractName(chain, step.to)} ${short(step.to)}: ${fmtUsdc(step.amountIn)} USDC → at least ${fmtEth(step.minOut)} ETH to ${to}, by ${fmtTime(step.deadline)}`;
    }
  }
}

/** The simulation of the plan on screen. The sign gate additionally treats a stale plan as pending. */
function simulationState(state: CardState): SignGate["simulation"] {
  if (!state.plan) return "none";
  if (state.phase.kind === "blocked") return "failed";
  const sim = state.simulation;
  if (!sim || sim.planId !== state.plan.id) return "pending";
  return sim.ok ? "passed" : "failed";
}

function check(state: CardState, decoded: DecodedPlan | null, decodeError: string | null, sim: SignGate["simulation"]): CardCheck {
  const { chain, plan, account, balances, phase, hold, quote, quoteError } = state;
  if (hold) return { tone: "stop", title: hold.title, items: hold.items };
  if (phase.kind === "failed") return { tone: "stop", title: "Transaction failed", items: `· ${phase.reason}` };
  if (phase.kind === "blocked") return { tone: "stop", title: "Stopped before signing", items: `· ${phase.reason}` };
  if (decodeError) return { tone: "stop", title: "These transactions do not match the card", items: `· ${decodeError}` };
  if (quoteError && !quote) return { tone: "stop", title: "No quote", items: `· ${quoteError}` };
  if (!quote) return { tone: "plain", title: "Getting a quote…" };
  if (!account) return { tone: "plain", title: "Connect a wallet to simulate this swap", items: "· nothing is sent until you sign" };
  if (state.prepError && !plan) return { tone: "stop", title: "Could not prepare the transactions", items: `· ${state.prepError}` };
  if (balances && balances.usdc < state.amountIn) {
    return { tone: "stop", title: `Not enough ${chain.usdc.label}`, items: `· you have ${fmtUsdc(balances.usdc)}, the swap needs ${fmtUsdc(state.amountIn)}` };
  }
  if (!plan || !decoded) return { tone: "plain", title: "Reading your wallet…" };

  const simResult = state.simulation;
  const detail: [string, string][] = [
    ["Wallet", short(plan.account)],
    ["Chain", `${chain.name} · ${chain.id}`],
    ...decoded.steps.map((s, i): [string, string] => [`Sign ${i + 1}/${decoded.steps.length}`, describeStep(chain, s, plan.account)]),
    ["Value", decoded.steps.every((s) => s.value === 0n) ? "0 ETH in every transaction" : "sends ETH"],
  ];
  if (simResult?.ok && simResult.planId === plan.id) {
    detail.push(["Simulated", `−${fmtUsdc(-simResult.usdcDelta)} USDC · +${fmtEth(simResult.ethDelta)} ETH · block ${simResult.block}`]);
  }
  if (sim === "pending") return { tone: "plain", title: "Simulating your transactions…", detail };
  if (sim === "failed" && simResult && !simResult.ok) return { tone: "stop", title: "Simulation failed", items: `· ${simResult.reason}`, detail };
  if (simResult?.ok && balances && balances.eth < simResult.gas * simResult.gasPrice) {
    return { tone: "stop", title: "Not enough ETH for gas", items: `· you have ${fmtEth(balances.eth)} ETH`, detail };
  }
  const approvals = decoded.steps.filter((s) => s.kind !== "swap").length;
  const items = [
    "· min received",
    isAddressEqual(decoded.swap.recipient, plan.account) ? "· goes to your address" : "· goes to ANOTHER address",
    approvals > 0 ? `· approves ${fmtUsdc(decoded.swap.amountIn)} USDC only` : "· no new approval",
  ].join(" ");
  const title = phase.kind === "signing" ? `Signing ${phase.step + 1} of ${phase.total}` : phase.kind === "done" ? "Signed and confirmed" : "Passed simulation";
  return { tone: "ok", title, items, detail };
}

export function cardView(state: CardState): CardView {
  const { chain, plan, quote, phase, balances } = state;
  let decoded: DecodedPlan | null = null;
  let decodeError: string | null = null;
  if (plan) {
    try {
      decoded = decodePlan(chain, plan.steps);
      if (!isAddressEqual(decoded.swap.recipient, plan.account)) {
        decodeError = `the swap pays ${short(decoded.swap.recipient)}, not the signer ${short(plan.account)}`;
        decoded = null;
      }
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
      decoded = null;
    }
  }
  const sim = simulationState(state);

  const amountIn = decoded ? decoded.swap.amountIn : state.amountIn;
  const sends: Amount = {
    amount: `−${fmtUsdc(amountIn)}`,
    token: "USDC",
    // After signing, the balance read before it is no longer true, so it is not shown.
    note: balances && phase.kind !== "done" ? `you have ${fmtUsdc(balances.usdc)}` : chain.usdc.label !== "USDC" ? chain.usdc.label : undefined,
  };

  let receives: Amount | undefined;
  if (decoded && plan) {
    receives = { amount: `+${fmtEth(plan.expectedOut)}`, token: "ETH", note: `min ${fmtEth(decoded.swap.minOut)}` };
  } else if (quote && !plan) {
    receives = { amount: `+${fmtEth(quote.expectedOut)}`, token: "ETH", note: `min ${fmtEth(minOutFor(quote.expectedOut))}` };
  }

  const items: CostItem[] = [];
  const simResult = state.simulation;
  const simOk = simResult?.ok && plan && simResult.planId === plan.id ? simResult : null;
  if (simOk) items.push({ label: `Gas, ${plan!.steps.length} transaction${plan!.steps.length > 1 ? "s" : ""} (simulated)`, value: `${fmtEth(simOk.gas * simOk.gasPrice)} ETH` });
  if (quote) items.push({ label: `Pool fee ${fmtFee(quote.lpFee)}`, value: `${fmtUsdc((amountIn * BigInt(quote.lpFee)) / 1_000_000n)} USDC` });
  items.push({ label: "DeSpell fee", value: "none" });

  const steps = plan?.steps.length ?? 0;
  const signLabel =
    phase.kind === "signing"
      ? phase.waiting === "wallet"
        ? "Confirm in your wallet…"
        : phase.waiting === "chain"
          ? "Waiting for the block…"
          : "Simulating…"
      : steps > 1
        ? `Approve and swap · ${steps} signatures`
        : "Swap";

  const status =
    phase.kind === "signing"
      ? { text: `Sign ${phase.step + 1}/${phase.total}`, accent: true }
      : phase.kind === "done"
        ? { text: "Received", accent: true }
        : { text: "Test network", accent: false };

  return {
    title: "USDC → ETH",
    scope: `· ${chain.name}`,
    status,
    sends,
    receives,
    route: { label: ROUTE_LABEL[chain.dex], note: quote ? `fee ${fmtFee(quote.lpFee)}` : undefined },
    cost: { total: simOk ? `${fmtEth(simOk.gas * simOk.gasPrice)} ETH gas` : "—", items },
    check: check(state, decoded, decodeError, sim),
    signLabel,
    simulation: sim === "passed" && state.stale ? "pending" : sim,
    busy: phase.kind === "signing",
    decoded,
  };
}
