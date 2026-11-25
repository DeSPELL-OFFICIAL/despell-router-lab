"use client";

import { useEffect, type ReactNode } from "react";
import type { Hex } from "viem";
import { SignCard } from "@/components/sign-card/sign-card";
import type { SwapChain } from "@/lib/swap/chains";
import { cardView, type ContestGate } from "@/lib/swap/view";
import { TestUsdcHelp } from "./test-usdc-help";
import { useSwap } from "./use-swap";

export type SwapCardProps = {
  chain: SwapChain;
  /** USDC base units (6 decimals). */
  amountIn: bigint;
  /** A contest's own rows, after the cost row (e.g. "Pools left out", "Circuit #7"). */
  extraRows?: ReactNode;
  /**
   * The contest's own check, required so a page cannot forget it: "pending" while it runs, "hold" to
   * stop, "ok" to allow. Only "ok" lets the sign button turn on. Pages with no check pass NO_CONTEST_CHECK.
   */
  gate: ContestGate;
  /**
   * Base Sepolia: pools the contest's check leaves out of the route. The quote skips them, and a plan through one of
   * them is not signed. `null` while the check has not answered yet (no quote is read). Default: none.
   */
  leaveOut?: readonly Hex[] | null;
  /** Cancel closes the card. Leave it out while another card is signing. */
  onCancel?: () => void;
  /** Told when this card starts and stops signing, so the page can keep other controls still. */
  onBusyChange?: (busy: boolean) => void;
};

/** A live USDC -> ETH signing card on one test network. */
export function SwapCard({ chain, amountIn, extraRows, gate, leaveOut = [], onCancel, onBusyChange }: SwapCardProps) {
  const swap = useSwap(chain, amountIn, gate, leaveOut);
  const phaseKind = swap.state.phase.kind;
  useEffect(() => {
    onBusyChange?.(phaseKind === "signing" || phaseKind === "unconfirmed");
  }, [phaseKind, onBusyChange]);
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
          swap.notice || swap.txLink ? (
            <span>
              {stuck ? "The transaction reverted. " : null}
              {swap.notice}
              {swap.txLink ? (
                <>
                  {" "}
                  <a href={swap.txLink} target="_blank" rel="noreferrer">
                    See it on the explorer
                  </a>
                </>
              ) : null}
            </span>
          ) : null
        }
      />
      <TestUsdcHelp chain={chain} amountIn={amountIn} usdc={swap.state.balances?.usdc ?? null} />
    </div>
  );
}
