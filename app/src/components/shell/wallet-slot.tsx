"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { useWalletPicker } from "@/components/wallet/providers";
import { LAB_CHAINS } from "@/components/wallet/config";

/*
  The header's wallet button: lists the browser wallets on this page
  (EIP-6963), connects one, shows the connected address and network, and
  disconnects. Connecting reads the address only; nothing is signed here.
*/

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const subscribeNothing = () => () => {};
/** Whether the page has a legacy injected provider (window.ethereum) at all. Client only. */
function useHasWindowProvider() {
  return useSyncExternalStore(
    subscribeNothing,
    () => typeof window !== "undefined" && "ethereum" in window,
    () => false,
  );
}

export function WalletSlot() {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const { open, setOpen } = useWalletPicker();
  const hasWindowProvider = useHasWindowProvider();
  const box = useRef<HTMLDivElement>(null);

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  // Wallets that announced themselves; the generic injected entry only when none did.
  const announced = connectors.filter((c) => c.id !== "injected");
  const list = announced.length > 0 ? announced : hasWindowProvider ? connectors.filter((c) => c.id === "injected") : [];

  const address = connection.address;
  const chain = LAB_CHAINS.find((c) => c.id === connection.chainId);

  return (
    <div className="lab-wallet" ref={box}>
      <button
        type="button"
        className="ds-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        data-wallet={address ? "connected" : "disconnected"}
        onClick={() => setOpen(!open)}
      >
        {address ? (
          <>
            <span className={chain ? "lab-dot" : "lab-dot is-off"} aria-hidden="true" />
            <span className="ds-mono">{short(address)}</span>
          </>
        ) : connection.status === "connecting" || connection.status === "reconnecting" ? (
          "Connecting…"
        ) : (
          "Connect wallet"
        )}
      </button>
      {open && (
        <div className="lab-wallet-menu" role="menu" aria-label="Wallet">
          {address ? (
            <>
              <p className="lab-wallet-line">
                <span className="ds-mono">{short(address)}</span>
                <span className="ds-dim">{chain ? chain.name : `network ${connection.chainId} (not used here)`}</span>
              </p>
              <button
                type="button"
                role="menuitem"
                className="ds-btn"
                onClick={() => {
                  disconnect.mutate();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : list.length === 0 ? (
            <p className="lab-wallet-line ds-dim">No browser wallet found on this page. Install one (MetaMask, Rabby, Coinbase Wallet) and reload.</p>
          ) : (
            <>
              <p className="lab-wallet-line ds-dim">Connect a browser wallet. It shares your address only.</p>
              {list.map((c) => (
                <button
                  key={c.uid}
                  type="button"
                  role="menuitem"
                  className="ds-btn lab-wallet-option"
                  disabled={connect.isPending}
                  onClick={() =>
                    connect.mutate(
                      { connector: c },
                      {
                        onSuccess: () => setOpen(false),
                      },
                    )
                  }
                >
                  {c.icon?.startsWith("data:image/") ? (
                    // EIP-6963 icons are data: URIs from the extension; anything else (a remote URL) is not loaded.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.icon} alt="" width={18} height={18} />
                  ) : null}
                  {c.id === "injected" ? "Browser wallet" : c.name}
                </button>
              ))}
              {connect.error && <p className="lab-wallet-line lab-wallet-error">{connect.error.message.split("\n")[0]}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
