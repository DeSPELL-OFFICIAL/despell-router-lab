import type { Metadata } from "next";
import { SwapDemo } from "@/components/swap/swap-demo";

export const metadata: Metadata = { title: "Test-network swap" };

export default function SwapPage() {
  return (
    <main className="lab-main">
      <div style={{ display: "grid", gap: 12 }}>
        <p className="lab-eyebrow">Shared part · test networks</p>
        <h1 className="lab-h1">Swap on a test network, signed from your own wallet</h1>
        <p className="lab-lede">
          Pick the swap and the same card appears on Base Sepolia (Uniswap v4) and GIWA Sepolia (Uniswap v3). Every amount, address and approval on a card is read back
          from the transactions your wallet will sign, and the button turns on only after those exact transactions pass a simulation.
        </p>
      </div>
      <SwapDemo />
    </main>
  );
}
