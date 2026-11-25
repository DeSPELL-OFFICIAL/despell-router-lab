import type { ReactNode } from "react";

/*
  The signing card every hackathon demo shares.

  Layout (from the unified design file, SignCard): 480 wide, padding 16,
  radius 14. Head -> sends / receives -> route -> cost (folded) -> extra rows
  -> one check box -> decision row. Each contest adds rows through `extraRows`
  and its own checks through `check`; nothing else about the card changes.

  The card never moves money by itself. The sign button is whatever the page
  passes as `action`; without one the card shows a disabled button so the slot
  is visible before a wallet is connected.
*/

export type Amount = {
  /** Signed amount as shown, e.g. "-100" or "+0.0418". */
  amount: string;
  token: string;
  chain?: string;
  /** Right-hand note, e.g. "≈ $100.00" or "expected ≈ $99.70 · min 0.0415". */
  note?: string;
};

export type CostItem = { label: string; value: string };

export type CheckTone = "ok" | "partial" | "stop" | "plain";

export type CardCheck = {
  tone: CheckTone;
  title: ReactNode;
  /** Short reasons after the title, e.g. "· min received · reviewed contract". */
  items?: string;
  /** Rows revealed by [Details]: wallet, chain, contract, value, every movement. */
  detail?: ReadonlyArray<readonly [string, string]>;
};

export type SignCardProps = {
  title: string;
  /** Dim text after the title, e.g. "· Base Sepolia". */
  scope?: string;
  /** Right side of the head, e.g. a status pill or "Sign 1/2". */
  meta?: ReactNode;
  sends?: Amount;
  receives?: Amount;
  route?: { label: ReactNode; note?: string };
  cost?: { total: string; items?: ReadonlyArray<CostItem> };
  /** Contest-specific rows, rendered after the cost row. */
  extraRows?: ReactNode;
  check?: CardCheck;
  /** Decision row. Defaults to [Cancel] + a disabled sign button. */
  action?: ReactNode;
  /** Label of the default sign button. */
  signLabel?: string;
};

function Mark({ token }: { token?: string }) {
  if (!token) return <span className="ds-logo is-empty" aria-hidden="true" />;
  return (
    <span className="ds-logo" aria-hidden="true">
      {token.slice(0, 3).toUpperCase()}
    </span>
  );
}

function Skeleton({ width }: { width: number }) {
  return <span className="ds-skel" style={{ width }} aria-hidden="true" />;
}

function FlowRow({ k, value, note }: { k: string; value?: ReactNode; note?: ReactNode }) {
  return (
    <div className="ds-flow" data-row={k.toLowerCase()}>
      <span className="ds-flow-k">{k}</span>
      <span className={value == null ? "ds-flow-v is-empty" : "ds-flow-v"}>{value ?? <Skeleton width={120} />}</span>
      {note !== undefined && <span className="ds-flow-u">{note}</span>}
    </div>
  );
}

function AmountRow({ k, amount }: { k: string; amount?: Amount }) {
  if (!amount) {
    return (
      <div className="ds-flow" data-row={k.toLowerCase()}>
        <span className="ds-flow-k">{k}</span>
        <span className="ds-flow-v is-empty">
          <Mark />
          <Skeleton width={120} />
        </span>
        <span className="ds-flow-u">
          <Skeleton width={64} />
        </span>
      </div>
    );
  }
  return (
    <FlowRow
      k={k}
      value={
        <>
          <Mark token={amount.token} />
          <span>
            {amount.amount} {amount.token}
          </span>
          {amount.chain && <span className="via">{amount.chain}</span>}
        </>
      }
      note={amount.note}
    />
  );
}

function Chevron() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CostFold({ cost }: { cost?: SignCardProps["cost"] }) {
  const items = cost?.items ?? [];
  return (
    <details className="ds-cost" data-row="cost">
      <summary className="ds-flow">
        <span className="ds-flow-k">Cost</span>
        <span className="ds-flow-v">
          <span className="ds-cost-toggle">
            ≈ {cost?.total ?? "—"}
            <Chevron />
          </span>
        </span>
      </summary>
      <div className="ds-cost-list">
        {items.length === 0 ? (
          <div>
            <span>Gas, route fee and DeSpell fee appear here</span>
          </div>
        ) : (
          items.map((item, i) => (
            // Rows are a fixed list per render; labels may repeat (two gas lines on two chains).
            <div key={i}>
              <span>{item.label}</span>
              <span className="v">{item.value}</span>
            </div>
          ))
        )}
      </div>
    </details>
  );
}

const MARK: Record<CheckTone, string> = { ok: "✓", partial: "!", stop: "!", plain: "" };

function CheckBox({ check }: { check?: CardCheck }) {
  const c: CardCheck = check ?? { tone: "plain", title: "Checks run when a quote arrives" };
  const detail = c.detail ?? [];
  const head = (
    <>
      <span className="ds-sum-mark" aria-hidden="true">
        {MARK[c.tone]}
      </span>
      <span className="ds-sum-title">
        <b>{c.title}</b>
        {c.items && <span className="items"> {c.items}</span>}
      </span>
    </>
  );
  // Nothing to reveal: a plain box, so it is not announced as expandable.
  if (detail.length === 0) {
    return (
      <div className={`ds-sum is-${c.tone}`} data-row="check">
        <div className="ds-sum-head">{head}</div>
      </div>
    );
  }
  return (
    <details className={`ds-sum is-${c.tone}`} data-row="check">
      <summary className="ds-sum-head">
        {head}
        <span className="ds-sum-toggle">
          <span className="when-closed">Details</span>
          <span className="when-open">Hide</span>
        </span>
      </summary>
      <dl className="ds-sum-detail">
        {detail.map(([k, v], i) => (
          <div key={i} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function SignCard(props: SignCardProps) {
  const { title, scope, meta, sends, receives, route, cost, extraRows, check, action, signLabel = "Sign" } = props;
  return (
    <section className="ds-card" aria-label={`${title} signing card`}>
      <div className="ds-card-head">
        <div className="ds-card-title">
          <span>{title}</span>
          {scope && <span className="scope">{scope}</span>}
        </div>
        <div className="ds-card-meta">{meta}</div>
      </div>
      <div className="ds-rows">
        <AmountRow k="Sends" amount={sends} />
        <AmountRow k="Receives" amount={receives} />
        <FlowRow k="Route" value={route?.label} note={route?.note} />
        <CostFold cost={cost} />
        {extraRows}
      </div>
      <CheckBox check={check} />
      {action ?? (
        <div className="ds-actions" data-row="actions">
          <button type="button" className="ds-btn is-lg is-secondary" disabled>
            Cancel
          </button>
          <button type="button" className="ds-btn is-lg is-primary" disabled>
            {signLabel}
          </button>
        </div>
      )}
    </section>
  );
}

export { FlowRow as SignCardRow };
