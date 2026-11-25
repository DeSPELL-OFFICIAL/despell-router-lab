"use client";

import { useActionState, useEffect, useState } from "react";
import { prepareBuyLink, type BuyLinkState } from "./actions";

type Props = {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  primary: boolean;
  /** Why [Buy] is off, shown under the button; undefined when it can be used. */
  disabledReason?: string;
};

const timeUtc = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "unknown" : new Date(t).toISOString().slice(11, 16);
};

/** True once `expiresAt` has passed; re-renders at that moment. */
function useExpired(expiresAt: string | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  useEffect(() => {
    if (Number.isNaN(at)) return;
    const wait = at - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 250, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [at]);
  return !Number.isNaN(at) && now >= at;
}

export function BuyButton({ chainId, tokenAddress, symbol, primary, disabledReason }: Props) {
  const [state, action, pending] = useActionState<BuyLinkState, FormData>(prepareBuyLink, { status: "idle" });
  const expired = useExpired(state.status === "ready" ? state.expiresAt : null);

  if (disabledReason) {
    return (
      <div className="cmc-buy">
        <button type="button" className="ds-btn is-secondary" disabled aria-describedby={`why-${chainId}-${tokenAddress}`}>
          Buy {symbol}
        </button>
        <p className="cmc-buy-note" id={`why-${chainId}-${tokenAddress}`}>
          {disabledReason}
        </p>
      </div>
    );
  }

  if (state.status === "ready" && !expired) {
    return (
      <div className="cmc-buy is-ready" data-handoff="ready">
        <p className="cmc-buy-line">
          Ready in DeSpell: pay {state.payAmount} {state.paySymbol}, receive {state.receiveSymbol}. Link valid until {timeUtc(state.expiresAt)} UTC.
        </p>
        <a className="ds-btn is-primary" href={state.url} target="_blank" rel="noopener noreferrer" data-handoff-link>
          Open DeSpell to review and sign
        </a>
        <p className="cmc-buy-note">
          Opens {state.host}. Nothing moves until you sign there with your own wallet.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="cmc-buy">
      <input type="hidden" name="chainId" value={chainId} />
      <input type="hidden" name="tokenAddress" value={tokenAddress} />
      <button type="submit" className={primary ? "ds-btn is-primary" : "ds-btn is-secondary"} disabled={pending}>
        {pending ? "Preparing link…" : `Buy ${symbol}`}
      </button>
      {expired && <p className="cmc-buy-note">The last link expired. Press Buy for a new one.</p>}
      {state.status === "error" && (
        <p className="cmc-buy-note is-error" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
