"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { isAddressEqual, type PublicClient } from "viem";
import { useConnection, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";
import { useWalletPicker } from "@/components/wallet/providers";
import type { Outcome, Prerequisite } from "@/components/sign-card/sign-card";
import { txUrl, type SwapChain } from "@/lib/swap/chains";
import { fmtEth } from "@/lib/swap/format";
import { buildPlan, type SwapPlan } from "@/lib/swap/plan";
import { readQuote, readWallet, receivedFromReceipt, simulatePlan, type Simulation } from "@/lib/swap/read";
import type { CardState, Hold, Phase } from "@/lib/swap/view";

/*
  One swap card's life: quote -> plan for the connected wallet -> simulate
  that plan -> sign its transactions one by one -> show what arrived.

  The plan and its simulation are produced together in one query, so the
  card can never pair a simulation with a different plan. When signing
  starts, that pair is frozen: the card keeps showing exactly what is being
  signed, and before every transaction the remaining transactions are
  simulated again on the latest block. If that simulation fails or would
  receive less than the signed minimum, signing stops.
*/

const REFRESH_MS = 20_000;

type Frozen = { plan: SwapPlan; simulation: Extract<Simulation, { ok: true }> };

function isUserRejection(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, name, message } = e as { code?: unknown; name?: unknown; message?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
    if (typeof message === "string" && /user (rejected|denied)/iu.test(message)) return true;
  }
  return false;
}

const firstLine = (error: unknown) => (error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error)).split("\n")[0];

export function useSwap(chain: SwapChain, amountIn: bigint, hold?: Hold | null) {
  const wagmiClient = usePublicClient({ chainId: chain.id });
  const client = wagmiClient as unknown as PublicClient | undefined;
  const connection = useConnection();
  const account = connection.address ?? null;
  const send = useSendTransaction();
  const switchChain = useSwitchChain();
  const picker = useWalletPicker();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase & { at?: number }>({ kind: "idle" });
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const busy = frozen !== null;

  const quoteQ = useQuery({
    queryKey: ["swap-quote", chain.id, amountIn.toString()],
    queryFn: () => readQuote(client!, chain, amountIn),
    enabled: Boolean(client) && !busy,
    refetchInterval: busy ? false : REFRESH_MS,
  });
  const walletKey = ["swap-wallet", chain.id, account] as const;
  const walletQ = useQuery({
    queryKey: walletKey,
    queryFn: () => readWallet(client!, chain, account!),
    enabled: Boolean(client && account) && !busy,
    refetchInterval: busy ? false : REFRESH_MS,
  });
  const quote = quoteQ.data ?? null;
  const wallet = walletQ.data ?? null;
  const prepQ = useQuery({
    queryKey: [
      "swap-prep",
      chain.id,
      account,
      quote?.expectedOut.toString(),
      quote?.lpFee,
      wallet ? [wallet.usdcBalance, wallet.erc20Allowance, wallet.permit2?.amount, wallet.permit2?.expiration].map(String).join(":") : null,
    ],
    queryFn: async () => {
      const plan = buildPlan({ chain, quote: quote!, wallet: wallet!, nowSec: Math.floor(Date.now() / 1000) });
      return { plan, simulation: await simulatePlan(client!, chain, plan) };
    },
    enabled: Boolean(client && quote && wallet && account && isAddressEqual(wallet.account, account)) && !busy,
    refetchInterval: busy ? false : REFRESH_MS,
  });

  // A stop found right before signing holds until a fresh plan has been simulated after it.
  const effectivePhase: Phase =
    phase.kind === "blocked" && phase.at !== undefined && prepQ.dataUpdatedAt > phase.at ? { kind: "idle" } : phase;

  const current = frozen ?? (prepQ.data && account && isAddressEqual(prepQ.data.plan.account, account) ? prepQ.data : null);

  const state: CardState = {
    chain,
    amountIn,
    quote: frozen?.plan.quote ?? quote,
    quoteError: quoteQ.error ? firstLine(quoteQ.error) : null,
    account,
    balances: wallet && account && isAddressEqual(wallet.account, account) ? { usdc: wallet.usdcBalance, eth: wallet.ethBalance } : null,
    plan: current?.plan ?? null,
    simulation: current?.simulation ?? null,
    phase: effectivePhase,
    hold: hold ?? null,
  };

  async function sign() {
    const prepared = prepQ.data;
    if (inFlight.current || !client || !prepared || !account) return;
    const { plan, simulation } = prepared;
    if (!simulation.ok || simulation.planId !== plan.id || !isAddressEqual(plan.account, account) || connection.chainId !== chain.id || hold) return;
    inFlight.current = true;
    setNotice(null);
    setFrozen({ plan, simulation });
    let step = 0;
    // Block of the last confirmed transaction of this plan: the next simulation must see it.
    let minBlock: bigint | undefined;
    const stop = (reason: string) => {
      setPhase({ kind: "blocked", reason, at: Date.now() });
      setFrozen(null);
      const done = step > 0 ? ` ${step} approval${step > 1 ? "s" : ""} went through;` : "";
      setNotice(`Stopped before signing:${done} ${reason}. Nothing else was sent.`);
    };
    try {
      for (; step < plan.steps.length; step++) {
        setPhase({ kind: "signing", step, total: plan.steps.length, waiting: "simulating" });
        if (Date.now() / 1000 > plan.deadline - 60) return stop("the quote is about to expire");
        let again = await simulatePlan(client, chain, plan, step, minBlock);
        // Right after a confirmation, a load-balanced RPC node can still be a block behind: try again briefly.
        for (let retry = 0; !again.ok && minBlock !== undefined && retry < 3; retry++) {
          await new Promise((r) => setTimeout(r, 1500));
          again = await simulatePlan(client, chain, plan, step, minBlock);
        }
        if (!again.ok) return stop(again.reason);
        setPhase({ kind: "signing", step, total: plan.steps.length, waiting: "wallet" });
        const tx = plan.steps[step].tx;
        const hash = await send.mutateAsync({ account: plan.account, chainId: chain.id, to: tx.to, data: tx.data, value: tx.value });
        setPhase({ kind: "signing", step, total: plan.steps.length, waiting: "chain" });
        const receipt = await client.waitForTransactionReceipt({ hash });
        minBlock = receipt.blockNumber;
        if (receipt.status !== "success") {
          setPhase({ kind: "failed", hash, reason: `transaction ${step + 1} of ${plan.steps.length} reverted on chain` });
          return;
        }
        if (plan.steps[step].kind === "swap") {
          setPhase({ kind: "done", hash, received: receivedFromReceipt(chain, receipt), block: receipt.blockNumber });
        }
      }
    } catch (error) {
      setFrozen(null);
      setPhase({ kind: "idle" });
      if (isUserRejection(error)) {
        setNotice(step === 0 ? "Declined in your wallet. Nothing was sent." : `Declined in your wallet. ${step} approval${step > 1 ? "s" : ""} went through; the swap was not sent.`);
      } else {
        const done = step > 0 ? ` ${step} approval${step > 1 ? "s" : ""} went through, then:` : "";
        setNotice(`Not sent.${done} ${firstLine(error)}`);
      }
    } finally {
      inFlight.current = false;
      void queryClient.invalidateQueries({ queryKey: walletKey });
    }
  }

  function reset() {
    setFrozen(null);
    setPhase({ kind: "idle" });
    setNotice(null);
  }

  let prerequisite: Prerequisite | undefined;
  if (!account) {
    prerequisite = { label: "Connect wallet", onClick: () => picker.setOpen(true), busy: connection.status === "connecting" };
  } else if (connection.chainId !== chain.id && !busy) {
    prerequisite = {
      label: `Switch to ${chain.name}`,
      onClick: () => switchChain.mutate({ chainId: chain.id }, { onError: (e) => setNotice(`Network not switched: ${firstLine(e)}`) }),
      busy: switchChain.isPending,
    };
  }

  let outcome: Outcome | undefined;
  if (effectivePhase.kind === "done") {
    const got = effectivePhase.received;
    outcome = {
      received: { amount: got === null ? "see transaction" : `+${fmtEth(got)}`, token: got === null ? "" : "ETH", chain: chain.name, note: `block ${effectivePhase.block}` },
      tx: { hash: effectivePhase.hash, href: txUrl(chain, effectivePhase.hash) },
      again: { label: "New quote", onClick: reset },
    };
  }

  const failedNotice = effectivePhase.kind === "failed" && effectivePhase.hash ? effectivePhase.hash : null;

  return { state, sign, reset, prerequisite, outcome, notice, failedTx: failedNotice ? txUrl(chain, failedNotice) : null, account, connectedChainId: connection.chainId };
}
