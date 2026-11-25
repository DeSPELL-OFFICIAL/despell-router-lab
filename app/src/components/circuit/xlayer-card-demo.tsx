"use client";

import { CircuitLine } from "@/components/circuit/circuit-line";
import { useCircuitCheck } from "@/components/circuit/use-circuit-check";
import { SwapCard } from "@/components/swap/swap-card";
import { DEMO_USDC } from "@/components/swap/swap-demo";
import { circuitGate, circuitLine } from "@/lib/circuit/check";
import { circuitPageHref } from "@/lib/circuit/links";
import { GIWA_SEPOLIA } from "@/lib/swap/chains";

/** The GIWA Sepolia swap card with the pool judgment circuit's line and gate. */
export function XLayerCardDemo({ demoMismatch }: { demoMismatch: boolean }) {
  const { check } = useCircuitCheck(GIWA_SEPOLIA.id, GIWA_SEPOLIA.pool.address, { demoMismatch });
  const href = circuitPageHref(GIWA_SEPOLIA.pool.address, demoMismatch);
  return (
    <SwapCard
      chain={GIWA_SEPOLIA}
      amountIn={DEMO_USDC}
      gate={circuitGate(check)}
      checkLine={circuitLine(check) ? <CircuitLine check={check} href={href} /> : undefined}
    />
  );
}
