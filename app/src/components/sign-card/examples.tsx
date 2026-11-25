import type { SignCardProps } from "./sign-card";

/* Example values only, for showing the card's shape. No quote behind them. */
export const EXAMPLE_SWAP: SignCardProps = {
  title: "USDC → ETH swap",
  scope: "· Base Sepolia",
  meta: <span className="ds-status is-accent"><i />Example</span>,
  sends: { amount: "−10", token: "USDC", note: "≈ $10.00" },
  receives: { amount: "+0.0029", token: "ETH", note: "expected ≈ $9.97 · min 0.0028" },
  route: { label: "Uniswap v4 · test pool", note: "about 2 s" },
  cost: {
    total: "$0.01",
    items: [
      { label: "Gas", value: "$0.01" },
      { label: "Route fee", value: "$0.00" },
      { label: "DeSpell fee", value: "0%" },
    ],
  },
  check: {
    tone: "ok",
    title: "Passed simulation",
    items: "· min received · goes to your address",
    detail: [
      ["Wallet", "0x7a3c…091c"],
      ["Chain", "Base Sepolia"],
      ["Contract", "Universal Router"],
      ["Value", "10 USDC · 10000000"],
      ["All moves", "−10 USDC · +0.0029 ETH expected"],
    ],
  },
  signLabel: "Swap",
};

export const EMPTY_SWAP: SignCardProps = {
  title: "Swap",
  scope: "· waiting for a quote",
  signLabel: "Sign",
};
