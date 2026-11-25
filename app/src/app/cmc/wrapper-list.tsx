import Link from "next/link";
import type { FoldedRowView, NoBestReason, RowView, WrapperScreen } from "@despell-lab/cmc";
import { BuyButton } from "./buy-button";

/*
  The wrapper list card (design: WrapperCompareCard). One row per wrapper,
  sorted by what $100 buys. The value column is that received value, not a
  token price; under it, the premium paid at execution and the shortfall
  (spend minus received). The top row opens with its details and [Buy].
*/

const usd = (v: number) => `${v < -0.004 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(2)}%`;
};
const compactUsd = (v: number | null) =>
  v == null ? "-" : `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`;
const timeUtc = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "unknown time" : `${new Date(t).toISOString().slice(11, 19)} UTC`;
};

const BUY_OFF: Record<string, string> = {
  not_on_despell: "Not on DeSpell's verified token list, so DeSpell cannot buy it.",
  no_pay_token: "No USDC route into this chain from here.",
  check_failed: "Could not ask DeSpell whether it can buy this. Try again.",
};

const FOLD_REASON: Record<FoldedRowView["reason"], string> = {
  non_evm_chain: "not an EVM chain",
  unsupported_chain: "no route source for this chain yet",
  no_contract: "CoinMarketCap lists no contract",
  no_route: "no route found",
  quote_failed: "quote failed",
  quote_incomplete: "quote missing its costs",
  premium_out_of_band: "price too far from the stock",
};

const BLOCKED_NOTE: Record<NonNullable<RowView["bestBlocked"]>, string> = {
  receives_more_than_spent: "Not marked best: it shows more value than was spent, which points at a pricing gap, not a bargain.",
  discount_over_1pct: "Not marked best: it trades over 1% below the stock. If the token is not exactly one share, that is a loss.",
  ranking_incomplete: "Not marked best: some quotes failed.",
};

const NO_BEST: Record<NoBestReason, string> = {
  incomplete: "Some quotes failed, so a wrapper that receives more may be missing. No wrapper is marked best.",
  all_blocked: "Every wrapper at the top trades too far below the stock to call it best.",
  nothing_ranked: "No wrapper could be quoted right now.",
};

function Badge({ kind }: { kind: RowView["badges"][number] }) {
  if (kind === "best") return <span className="ds-status is-accent" data-badge="best"><i />Receives the most</span>;
  if (kind === "best_buyable") return <span className="ds-status is-accent" data-badge="best-buyable"><i />Most you can buy on DeSpell</span>;
  return <span className="ds-status" data-badge="tied">Tied with best</span>;
}

function Row({ row, open }: { row: RowView; open: boolean }) {
  const canBuy = row.buy.kind === "enabled";
  const primary = canBuy && (row.badges.includes("best") || row.badges.includes("best_buyable"));
  return (
    <details className="cmc-row" open={open} data-row={row.key}>
      <summary className="cmc-row-head">
        <span className="ds-logo" aria-hidden="true">{row.symbol.slice(0, 3).toUpperCase()}</span>
        <span className="cmc-row-name">
          <b>{row.symbol}</b>
          <span className="cmc-row-sub">
            {row.chainName} · {row.issuer ?? "unknown issuer"}
          </span>
          {row.badges.length > 0 && (
            <span className="cmc-row-badges">
              {row.badges.map((b) => (
                <Badge key={b} kind={b} />
              ))}
            </span>
          )}
        </span>
        <span className="cmc-row-val">
          <b className="ds-tnum">{usd(row.receivedUsd)}</b>
          <span className="cmc-row-sub ds-tnum">
            premium {pct(row.premiumPct)} · short {usd(row.shortfallUsd)}
          </span>
        </span>
      </summary>
      <div className="cmc-row-body">
        <dl className="cmc-facts ds-tnum">
          <div><dt>Known cost</dt><dd>{usd(row.knownCostUsd)} <span className="ds-dim">gas + fees</span></dd></div>
          <div><dt>Price gap</dt><dd>{usd(row.priceGapUsd)} <span className="ds-dim">execution vs reference</span></dd></div>
          <div><dt>Token</dt><dd>{row.cmcPriceUsd == null ? "-" : usd(row.cmcPriceUsd)} <span className="ds-dim">CMC</span></dd></div>
          <div><dt>24h volume</dt><dd>{compactUsd(row.volume24hUsd)} <span className="ds-dim">CMC</span></dd></div>
        </dl>
        {row.bestBlocked && <p className="cmc-note">{BLOCKED_NOTE[row.bestBlocked]}</p>}
        <BuyButton
          chainId={row.chainId}
          tokenAddress={row.address}
          symbol={row.symbol}
          primary={primary}
          disabledReason={canBuy ? undefined : BUY_OFF[row.buy.kind === "disabled" ? row.buy.reason : "check_failed"]}
        />
      </div>
    </details>
  );
}

type ListProps = {
  screen: WrapperScreen;
  connectorHost: string;
  production: boolean;
  /** While quotes keep failing the same screen is kept until this time; reloading before then shows it again. */
  backingOffUntil?: string | null;
};

export function WrapperList({ screen, connectorHost, production, backingOffUntil = null }: ListProps) {
  return (
    <section className="ds-card cmc-card" aria-label={`${screen.asset.name} tokenized wrappers`}>
      <div className="ds-card-head">
        <span className="ds-card-title">
          <span>{screen.asset.name} tokenized stock</span>
          <span className="scope">· what ${screen.spendUsd} buys</span>
        </span>
      </div>

      {screen.noBest && (
        <div className="ds-sum is-partial" role="status" data-state="no-best">
          <div className="ds-sum-head">
            <span className="ds-sum-mark">!</span>
            <span className="ds-sum-title">
              <b>No winner this time.</b> {NO_BEST[screen.noBest]}
            </span>
            {backingOffUntil ? (
              <span className="ds-sum-toggle" data-next-measure>
                Next measurement after {timeUtc(backingOffUntil)}
              </span>
            ) : (
              <Link href="/cmc" className="ds-sum-toggle" prefetch={false}>
                Measure again
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="cmc-list">
        {screen.rows.map((row) => (
          <Row key={row.key} row={row} open={row.badges.includes("best") || row.badges.includes("best_buyable")} />
        ))}
      </div>

      {screen.folded.length > 0 && (
        <details className="cmc-folded">
          <summary>
            {screen.folded.length} more wrapper{screen.folded.length === 1 ? "" : "s"} without a route
          </summary>
          <ul>
            {screen.folded.map((f) => (
              <li key={f.key}>
                <b>{f.symbol}</b> <span className="ds-dim">{f.chainName ?? "no chain"} · {f.issuer ?? "unknown issuer"}</span> — {FOLD_REASON[f.reason]}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="ds-footline cmc-source" data-source>
        Prices CoinMarketCap RWA · reference {usd(screen.referencePriceUsd)} = CMC average tokenized price · as of {timeUtc(screen.pricesAsOf)} ·
        routes LI.FI at {timeUtc(screen.quotedAt)}
      </p>
      <p className="ds-footline cmc-source" data-connector>
        Buy links open in DeSpell on {connectorHost}
        {production ? " (production: signing there buys the real token)" : " (not production: a test deployment)"}.
      </p>
    </section>
  );
}
