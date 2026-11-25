import type { ReactNode } from "react";

/*
  The signing card every hackathon demo shares.

  Layout (from the unified design file, SignCard): 480 wide, padding 16,
  radius 14. Head -> sends / receives -> route -> cost (folded) -> extra rows
  -> one check box -> decision row. Each contest adds rows through `extraRows`
  and its own checks through `check`; nothing else about the card changes.

  The card never moves money by itself, and it alone draws the sign button.
  A page hands it a `sign` gate (the result of simulating exactly the
  transactions the button signs, plus the handler); the card enables the
  button only when `canSign` holds: something leaves and something arrives,
  that simulation passed, the check box is "ok", and no signature is in
  flight. A page cannot pass its own sign button. Before a wallet is
  connected or on the wrong network, `prerequisite` takes the button's place
  (Connect wallet, Switch network). After signing, `outcome` replaces the
  decision row with what arrived and the transaction.
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

export type SignGate = {
  /** Simulation of exactly the transactions this button signs. Only "passed" can enable the button. */
  simulation: "none" | "pending" | "passed" | "failed";
  /** A signature or transaction is in flight: the button stays off so it cannot be pressed twice. */
  busy?: boolean;
  onSign: () => void;
};

/** A step the wallet needs before signing makes sense: connect, switch network. */
export type Prerequisite = { label: string; onClick: () => void; busy?: boolean };

export type Outcome = {
  /** What arrived, e.g. { amount: "+0.006045", token: "ETH" }. */
  received: Amount;
  tx: { hash: string; href: string; label?: string };
  again?: { label: string; onClick: () => void };
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
  /** The sign button's gate. Without it the button is drawn disabled. */
  sign?: SignGate;
  /** Replaces the sign button while the wallet is not ready. */
  prerequisite?: Prerequisite;
  onCancel?: () => void;
  /** After signing: what arrived and the transaction, in place of the decision row. */
  outcome?: Outcome;
  /** One line under the decision row, e.g. "Declined in your wallet. Nothing was sent." */
  notice?: ReactNode;
  /** Label of the sign button. */
  signLabel?: string;
};

/** The only rule that turns the sign button on. */
export function canSign(props: Pick<SignCardProps, "sends" | "receives" | "check" | "sign" | "prerequisite" | "outcome">): boolean {
  const { sends, receives, check, sign, prerequisite, outcome } = props;
  return Boolean(sends && receives && sign && sign.simulation === "passed" && !sign.busy && check?.tone === "ok" && !prerequisite && !outcome);
}

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

function AmountRow({ k, amount }: { k: string; amount?: Amount | null }) {
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

function Decision({ props }: { props: SignCardProps }) {
  const { sign, prerequisite, onCancel, signLabel = "Sign" } = props;
  const enabled = canSign(props);
  return (
    <div className="ds-actions" data-row="actions">
      <button type="button" className="ds-btn is-lg is-secondary" disabled={!onCancel || sign?.busy} onClick={onCancel}>
        Cancel
      </button>
      {prerequisite ? (
        <button type="button" className="ds-btn is-lg is-primary" data-action="prerequisite" disabled={prerequisite.busy} onClick={prerequisite.onClick}>
          {prerequisite.label}
        </button>
      ) : (
        <button
          type="button"
          className="ds-btn is-lg is-primary"
          data-action="sign"
          disabled={!enabled}
          aria-busy={sign?.busy || undefined}
          // The handler that runs must re-check the latest state itself (useSwap's sign() does: plan,
          // simulation, chain, hold, in-flight) and simulate again before sending. No handler at all
          // without a gate, so the card still renders from a Server Component.
          onClick={sign && enabled ? sign.onSign : undefined}
        >
          {signLabel}
        </button>
      )}
    </div>
  );
}

function OutcomeRows({ outcome }: { outcome: Outcome }) {
  return (
    <>
      <AmountRow k="Received" amount={outcome.received} />
      <FlowRow
        k="Tx"
        value={
          <a className="ds-mono" href={outcome.tx.href} target="_blank" rel="noreferrer">
            {outcome.tx.label ?? `${outcome.tx.hash.slice(0, 10)}…${outcome.tx.hash.slice(-8)}`}
          </a>
        }
      />
    </>
  );
}

export function SignCard(props: SignCardProps) {
  const { title, scope, meta, sends, receives, route, cost, extraRows, check, outcome, notice } = props;
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
        {outcome && <OutcomeRows outcome={outcome} />}
      </div>
      <CheckBox check={check} />
      {outcome ? (
        outcome.again && (
          <div className="ds-actions" data-row="actions">
            <button type="button" className="ds-btn is-lg is-secondary" onClick={outcome.again.onClick}>
              {outcome.again.label}
            </button>
          </div>
        )
      ) : (
        <Decision props={props} />
      )}
      {notice && (
        <p className="ds-footline" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

export { FlowRow as SignCardRow };
