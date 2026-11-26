// What taping the circuit out on X Layer costs, in OKB.
//
// The three fees were read from X Layer mainnet (chain 196) on 2026-11-25 with view calls on the OrderGuard XL
// processor and its transistor contract (scripts/check-onchain.ts prints them again). They are the same as the
// figures the reference implementation measured. A processor of our own may charge differently; DES-699 reads its
// fees again before paying. Gas is separate and small (README).

export const OKB_WEI = 10n ** 18n;

export const FEES_WEI = {
  /** `TAPEOUT_FEE()` on the processor, once per circuit. */
  tapeout: 1_300_000_000_000_000n,
  /** `mintPrice()` on the transistor contract, per NAND transistor. */
  perNand: 100_000_000_000_000n,
  /** `protocolFee()` on the transistor contract, once per mint call. */
  protocolPerMint: 660_000_000_000_000n,
} as const;

export type TapeoutCost = {
  readonly nands: number;
  readonly tapeoutWei: bigint;
  readonly nandsWei: bigint;
  readonly protocolWei: bigint;
  /** Tape-out fee plus NAND transistors: the figure the issue asks for. */
  readonly feesWei: bigint;
  /** Everything above plus one mint call's protocol fee. */
  readonly totalWei: bigint;
};

export function tapeoutCost(nands: number, fees: typeof FEES_WEI = FEES_WEI): TapeoutCost {
  if (!Number.isInteger(nands) || nands < 1) throw new RangeError("a circuit has at least one NAND");
  const nandsWei = fees.perNand * BigInt(nands);
  const feesWei = fees.tapeout + nandsWei;
  return {
    nands,
    tapeoutWei: fees.tapeout,
    nandsWei,
    protocolWei: fees.protocolPerMint,
    feesWei,
    totalWei: feesWei + fees.protocolPerMint,
  };
}

/** Format wei as OKB with every significant digit kept. */
export function formatOkb(wei: bigint): string {
  const whole = wei / OKB_WEI;
  const fraction = (wei % OKB_WEI).toString().padStart(18, "0").replace(/0+$/u, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
