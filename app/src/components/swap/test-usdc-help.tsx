"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { encodeFunctionData, type Hex, type PublicClient } from "viem";
import { useConnection, usePublicClient, useSendTransaction } from "wagmi";
import { mockMintAbi } from "@/lib/swap/abi";
import { txUrl, type SwapChain } from "@/lib/swap/chains";
import { fmtUsdc, short } from "@/lib/swap/format";

/*
  Where test USDC comes from, shown under a card whose wallet has too little.
  Base Sepolia: Circle's faucet. GIWA Sepolia: the mock token's public mint,
  sent from the user's own wallet (it moves no funds; it costs gas only).
*/
export function TestUsdcHelp({ chain, amountIn, usdc }: { chain: SwapChain; amountIn: bigint; usdc: bigint | null }) {
  const connection = useConnection();
  const client = usePublicClient({ chainId: chain.id }) as unknown as PublicClient | undefined;
  const send = useSendTransaction();
  const queryClient = useQueryClient();
  const [minted, setMinted] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (usdc === null || usdc >= amountIn) {
    return minted ? (
      <p className="lab-swap-help">
        Minted {fmtUsdc(amountIn)} {chain.usdc.label}.{" "}
        <a href={txUrl(chain, minted)} target="_blank" rel="noreferrer">
          Transaction
        </a>
      </p>
    ) : null;
  }

  if (chain.faucet.kind === "link") {
    return (
      <p className="lab-swap-help">
        Need test USDC on {chain.name}?{" "}
        <a href={chain.faucet.href} target="_blank" rel="noreferrer">
          {chain.faucet.label} ↗
        </a>
      </p>
    );
  }

  const account = connection.address;
  const onChain = connection.chainId === chain.id;
  async function mint() {
    if (!account || !client || pending) return;
    setPending(true);
    setError(null);
    try {
      const hash = await send.mutateAsync({
        account,
        chainId: chain.id,
        to: chain.usdc.address,
        data: encodeFunctionData({ abi: mockMintAbi, functionName: "mint", args: [account, amountIn] }),
        value: 0n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setError(`The mint reverted on chain: ${txUrl(chain, hash)}`);
        return;
      }
      setMinted(hash);
      await queryClient.invalidateQueries({ queryKey: ["swap-wallet", chain.id, account] });
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="lab-swap-help">
      <span>
        {chain.usdc.label} is a test token anyone can mint. This sends <code>mint({account ? short(account) : "you"}, {fmtUsdc(amountIn)})</code> from your wallet; it costs gas only.
      </span>
      <button type="button" className="ds-btn" data-action="mint" disabled={!account || !onChain || pending} onClick={() => void mint()}>
        {pending ? "Minting…" : `Mint ${fmtUsdc(amountIn)} ${chain.usdc.label}`}
      </button>
      {!onChain && account && <span className="ds-dim">Switch to {chain.name} first.</span>}
      {error && <span className="lab-wallet-error">{error}</span>}
    </div>
  );
}
