"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isAddressEqual, TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import { useConnection, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";
import { useWalletPicker } from "@/components/wallet/providers";
import type { Outcome, Prerequisite } from "@/components/sign-card/sign-card";
import { txUrl, type SwapChain } from "@/lib/swap/chains";
import { fmtEth } from "@/lib/swap/format";
import { buildPlan, type SwapPlan } from "@/lib/swap/plan";
import { afterRecheck, afterSigning, firstLine, type CardUpdate } from "@/lib/swap/outcome";
import { readQuote, readWallet, simulatePlan, type Simulation } from "@/lib/swap/read";
import { recheckUnconfirmed, runSigning, type Replacement, type WaitResult } from "@/lib/swap/sign-loop";
import { effectivePhase as phaseOnScreen, gateStopReason, type CardState, type ContestGate, type Phase } from "@/lib/swap/view";

/*
  One swap card's life: quote -> plan for the connected wallet -> simulate
  that plan -> sign its transactions one by one -> show what arrived.

  The plan and its simulation are produced together in one query, so the
  card can never pair a simulation with a different plan. When signing
  starts, that pair is frozen: the card keeps showing exactly what is being
  signed, and before every transaction the remaining transactions are
  simulated again on the latest block. If that simulation fails or would
  receive less than the signed minimum, the contest gate is not open, or the
  card goes away (closed, page left), signing stops before the next
  transaction, and the card lists what stays approved.

  A transaction the wallet sent but whose receipt could not be read stays
  "unconfirmed": the plan stays frozen and nothing new can be signed until
  [Check again] reads its receipt.
*/

const REFRESH_MS = 20_000;

/** Wall-clock time for event handlers (never called while rendering). */
const nowMs = () => Date.now();

type Frozen = { plan: SwapPlan; simulation: Extract<Simulation, { ok: true }> };

export function useSwap(chain: SwapChain, amountIn: bigint, gate: ContestGate) {
  const wagmiClient = usePublicClient({ chainId: chain.id });
  const client = wagmiClient as unknown as PublicClient | undefined;
  const connection = useConnection();
  const account = connection.address ?? null;
  const send = useSendTransaction();
  const switchChain = useSwitchChain();
  const picker = useWalletPicker();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const busy = frozen !== null;
  const [rechecking, setRechecking] = useState(false);
  // Read by the signing loop between transactions: it must see a closed gate or an unmount that happens mid-way.
  const alive = useRef(true);
  const gateRef = useRef<ContestGate>(gate);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    gateRef.current = gate;
  }, [gate]);

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

  // A stop found right before signing holds until a fresh plan has been simulated after it (or, without `at`, until reload).
  const effectivePhase: Phase = phaseOnScreen(phase, prepQ.dataUpdatedAt);

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
    gate,
  };

  /** Waits for a receipt and notes a replacement the way the signing loop judges it. */
  async function waitFor(hash: Hex, timeout?: number): Promise<WaitResult> {
    const seen: { replacement: Replacement | null } = { replacement: null };
    const receipt = await client!.waitForTransactionReceipt({
      hash,
      timeout,
      onReplaced: (r) => {
        seen.replacement = { reason: r.reason, to: r.transaction.to, data: r.transaction.input, value: r.transaction.value };
      },
    });
    return { receipt, replacement: seen.replacement };
  }

  /** Applies an outcome from lib/swap/outcome.ts to the card. */
  function apply(update: CardUpdate) {
    if (update.frozen === "release") setFrozen(null);
    if (update.phase) setPhase(update.phase);
    setNotice(update.notice);
  }

  async function sign() {
    const prepared = prepQ.data;
    if (inFlight.current || !client || !prepared || prepQ.isPlaceholderData || !account) return;
    const { plan, simulation } = prepared;
    if (!simulation.ok || simulation.planId !== plan.id || !isAddressEqual(plan.account, account) || connection.chainId !== chain.id) return;
    if (gateStopReason(gateRef.current)) return;
    inFlight.current = true;
    setNotice(null);
    setFrozen({ plan, simulation });
    try {
      const result = await runSigning(plan, {
        simulate: (from, minBlock) => simulatePlan(client, chain, plan, from, minBlock),
        send: (tx) => send.mutateAsync({ account: plan.account, chainId: chain.id, to: tx.to, data: tx.data, value: tx.value }),
        wait: (hash) => waitFor(hash),
        nonceOf: (hash) => client.getTransaction({ hash }).then((t) => t.nonce),
        stopReason: () => (!alive.current ? "the card was closed" : gateStopReason(gateRef.current)),
        onPhase: (p) => {
          if (alive.current) setPhase(p);
        },
        nowMs,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      if (alive.current) apply(afterSigning(chain, plan, result, nowMs()));
    } catch (error) {
      // runSigning returns its outcomes; this is a bug path. Keep the card locked rather than offer a new plan,
      // because what was sent is unknown.
      if (alive.current) setNotice(`Signing stopped on an unexpected error: ${firstLine(error)}. Check your wallet's activity, then reload the page.`);
    } finally {
      inFlight.current = false;
      void queryClient.invalidateQueries({ queryKey: walletKey });
    }
  }

  /** [Check again] for an unconfirmed transaction: read its receipt once more, briefly. */
  async function recheck() {
    if (!client || !frozen || effectivePhase.kind !== "unconfirmed" || rechecking) return;
    const { plan } = frozen;
    const { step, hash, nonce } = effectivePhase;
    setRechecking(true);
    try {
      const r = await recheckUnconfirmed(plan, step, hash, nonce, {
        wait: (h) => waitFor(h, 15_000),
        nonceOf: (h) => client.getTransaction({ hash: h }).then((t) => t.nonce),
        latestNonce: () => client.getTransactionCount({ address: plan.account, blockTag: "latest" }),
        // Null only when the node says the receipt does not exist; any other error rejects and keeps it pending.
        receipt: (h) =>
          client.getTransactionReceipt({ hash: h }).catch((e: unknown) => {
            if (e instanceof TransactionReceiptNotFoundError) return null;
            throw e;
          }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      if (alive.current) apply(afterRecheck(chain, plan, step, r, nowMs()));
    } catch (error) {
      if (alive.current) setNotice(`Still not confirmed (${firstLine(error)}). Check again in a moment, or check it on the explorer and reload the page; nothing new can be signed until then.`);
    } finally {
      setRechecking(false);
      void queryClient.invalidateQueries({ queryKey: walletKey });
    }
  }

  function reset() {
    setFrozen(null);
    setPhase({ kind: "idle" });
    setNotice(null);
  }

  let prerequisite: Prerequisite | undefined;
  if (effectivePhase.kind === "unconfirmed") {
    prerequisite = { label: rechecking ? "Checking…" : "Check again", onClick: () => void recheck(), busy: rechecking };
  } else if (!account) {
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

  const shownHash = (effectivePhase.kind === "failed" || effectivePhase.kind === "unconfirmed") && effectivePhase.hash ? effectivePhase.hash : null;

  return { state, sign, reset, busy, prerequisite, outcome, notice, txLink: shownHash ? txUrl(chain, shownHash) : null };
}
