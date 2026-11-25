"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isAddressEqual, type PublicClient } from "viem";
import { useConnection, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";
import { useWalletPicker } from "@/components/wallet/providers";
import type { Outcome, Prerequisite } from "@/components/sign-card/sign-card";
import { txUrl, type SwapChain } from "@/lib/swap/chains";
import { fmtEth } from "@/lib/swap/format";
import { buildPlan, type SwapPlan } from "@/lib/swap/plan";
import { readQuote, readWallet, receivedFromReceipt, simulatePlan, type Simulation } from "@/lib/swap/read";
import { runSigning } from "@/lib/swap/sign-loop";
import type { CardState, Hold, Phase } from "@/lib/swap/view";

/*
  One swap card's life: quote -> plan for the connected wallet -> simulate
  that plan -> sign its transactions one by one -> show what arrived.

  The plan and its simulation are produced together in one query, so the
  card can never pair a simulation with a different plan. When signing
  starts, that pair is frozen: the card keeps showing exactly what is being
  signed, and before every transaction the remaining transactions are
  simulated again on the latest block. If that simulation fails or would
  receive less than the signed minimum, a contest hold arrives, or the card
  goes away (closed, page left), signing stops before the next transaction.
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
  // Read by the signing loop between transactions: it must see a hold or an unmount that happens mid-way.
  const alive = useRef(true);
  const holdRef = useRef<Hold | null>(hold ?? null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    holdRef.current = hold ?? null;
  }, [hold]);

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
    // Keep the last plan and its simulation on screen while the next pair is built; the button stays off meanwhile.
    placeholderData: keepPreviousData,
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
    prepError: walletQ.error && !wallet ? `could not read the wallet: ${firstLine(walletQ.error)}` : prepQ.error && !prepQ.data ? firstLine(prepQ.error) : null,
    stale: !frozen && prepQ.isPlaceholderData,
    account,
    balances: wallet && account && isAddressEqual(wallet.account, account) ? { usdc: wallet.usdcBalance, eth: wallet.ethBalance } : null,
    plan: current?.plan ?? null,
    simulation: current?.simulation ?? null,
    phase: effectivePhase,
    hold: hold ?? null,
  };

  async function sign() {
    const prepared = prepQ.data;
    if (inFlight.current || !client || !prepared || prepQ.isPlaceholderData || !account) return;
    const { plan, simulation } = prepared;
    if (!simulation.ok || simulation.planId !== plan.id || !isAddressEqual(plan.account, account) || connection.chainId !== chain.id || holdRef.current) return;
    inFlight.current = true;
    setNotice(null);
    setFrozen({ plan, simulation });
    const approvals = (n: number) => (n > 0 ? ` ${n} approval${n > 1 ? "s" : ""} went through;` : "");
    const result = await runSigning(plan, {
      simulate: (from, minBlock) => simulatePlan(client, chain, plan, from, minBlock),
      send: (tx) => send.mutateAsync({ account: plan.account, chainId: chain.id, to: tx.to, data: tx.data, value: tx.value }),
      wait: (hash) => client.waitForTransactionReceipt({ hash }),
      stopReason: () => (!alive.current ? "the card was closed" : holdRef.current ? `held: ${holdRef.current.title}` : null),
      onPhase: (p) => {
        if (alive.current) setPhase(p);
      },
      nowMs: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    inFlight.current = false;
    void queryClient.invalidateQueries({ queryKey: walletKey });
    if (!alive.current) return;
    switch (result.kind) {
      case "done":
        setPhase({ kind: "done", hash: result.hash, received: receivedFromReceipt(chain, result.receipt), block: result.receipt.blockNumber });
        return;
      case "reverted":
        setPhase({ kind: "failed", hash: result.hash, reason: `transaction ${result.step + 1} of ${plan.steps.length} reverted on chain` });
        return;
      case "stopped":
        setFrozen(null);
        setPhase({ kind: "blocked", reason: result.reason, at: Date.now() });
        setNotice(`Stopped before signing:${approvals(result.step)} ${result.reason}. Nothing else was sent.`);
        return;
      case "error":
        setFrozen(null);
        setPhase({ kind: "idle" });
        setNotice(
          isUserRejection(result.error)
            ? result.step === 0
              ? "Declined in your wallet. Nothing was sent."
              : `Declined in your wallet.${approvals(result.step)} the swap was not sent.`
            : `Not sent.${approvals(result.step)} ${firstLine(result.error)}`,
        );
        return;
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

  return { state, sign, reset, busy, prerequisite, outcome, notice, failedTx: failedNotice ? txUrl(chain, failedNotice) : null };
}
