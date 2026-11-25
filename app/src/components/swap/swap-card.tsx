"use client";

import { useEffect, type ReactNode } from "react";
import { SignCard } from "@/components/sign-card/sign-card";
import type { SwapChain } from "@/lib/swap/chains";
import { cardView, type Hold } from "@/lib/swap/view";
import { TestUsdcHelp } from "./test-usdc-help";
import { useSwap } from "./use-swap";

export type SwapCardProps = {
  chain: SwapChain;
  /** USDC base units (6 decimals). */
  amountIn: bigint;
  /** A contest's own rows, after the cost row (e.g. "Pools left out", "Circuit #7"). */
  extraRows?: ReactNode;
  /** A contest's reason to stop signing; turns the check box to stop and the sign button off. */
  hold?: Hold | null;
  /** Cancel closes the card. Leave it out while another card is signing. */
  onCancel?: () => void;
  /** Told when this card starts and stops signing, so the page can keep other controls still. */
  onBusyChange?: (busy: boolean) => void;
};

/** A live USDC -> ETH signing card on one test network. */
export function SwapCard({ chain, amountIn, extraRows, hold, onCancel, onBusyChange }: SwapCardProps) {
  const swap = useSwap(chain, amountIn, hold);
  useEffect(() => {
    onBusyChange?.(swap.busy && swap.state.phase.kind === "signing");
  }, [swap.busy, swap.state.phase.kind, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const view = cardView(swap.state);
  const phase = swap.state.phase.kind;
  const stuck = phase === "failed";
  return (
    <div className="lab-swap" data-chain={chain.id} data-phase={phase} data-simulation={view.simulation}>
      <SignCard
        title={view.title}
        scope={view.scope}
        meta={
          <span className={view.status.accent ? "ds-status is-accent" : "ds-status"}>
            <i />
            {view.status.text}
          </span>
        }
        sends={view.sends}
        receives={view.receives}
        route={view.route}
        cost={view.cost}
        extraRows={extraRows}
        check={view.check}
        signLabel={view.signLabel}
        sign={{ simulation: view.simulation, busy: view.busy, onSign: () => void swap.sign() }}
        prerequisite={swap.prerequisite}
        onCancel={stuck ? swap.reset : view.busy ? undefined : onCancel}
        outcome={swap.outcome}
        notice={
          stuck && swap.failedTx ? (
            <>
              The transaction reverted.{" "}
              <a href={swap.failedTx} target="_blank" rel="noreferrer">
                See it on the explorer
              </a>
            </>
          ) : (
            swap.notice
          )
        }
      />
      <TestUsdcHelp chain={chain} amountIn={amountIn} usdc={swap.state.balances?.usdc ?? null} />
    </div>
  );
}
