"use client";

import { useCallback, useState } from "react";
import { BASE_SEPOLIA, GIWA_SEPOLIA } from "@/lib/swap/chains";
import { NO_CONTEST_CHECK } from "@/lib/swap/view";
import { SwapCard } from "./swap-card";

/** Demo amount decided for DES-697: one Circle faucet drip is 20 USDC. */
export const DEMO_USDC = 10_000_000n;

export function SwapDemo() {
  const [picked, setPicked] = useState(false);
  // While either card is signing, neither card's Cancel may close them both.
  const [signing, setSigning] = useState<Record<number, boolean>>({});
  const anySigning = Object.values(signing).some(Boolean);
  const onBaseBusy = useCallback((busy: boolean) => setSigning((s) => ({ ...s, [BASE_SEPOLIA.id]: busy })), []);
  const onGiwaBusy = useCallback((busy: boolean) => setSigning((s) => ({ ...s, [GIWA_SEPOLIA.id]: busy })), []);
  const close = anySigning ? undefined : () => setPicked(false);
  return (
    <section aria-label="Swap" style={{ display: "grid", gap: 20 }}>
      <div className="lab-intents" role="group" aria-label="What to do">
        <button type="button" className="lab-intent" aria-pressed={picked} onClick={() => setPicked(true)}>
          Swap 10 USDC to ETH
        </button>
      </div>
      {picked && (
        <div className="lab-swap-grid">
          {/* This page has no contest check of its own; contest pages pass their gate here instead. */}
          <SwapCard chain={BASE_SEPOLIA} amountIn={DEMO_USDC} gate={NO_CONTEST_CHECK} onCancel={close} onBusyChange={onBaseBusy} />
          <SwapCard chain={GIWA_SEPOLIA} amountIn={DEMO_USDC} gate={NO_CONTEST_CHECK} onCancel={close} onBusyChange={onGiwaBusy} />
        </div>
      )}
    </section>
  );
}
