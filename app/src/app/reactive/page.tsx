import type { Metadata } from "next";
import {
  journalNewestFirst,
  rangeLine,
  readMarksNow,
  reflexPage,
  shortHex,
  statusLabel,
  summarize,
  utc,
  type JournalEntry,
  type TxRef,
} from "@/lib/reflex";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "On-chain reflex · Reactive Omni",
  description:
    "A pool setting changes, and a Reactive contract marks that pool as narrowed on-chain about a second later. Measured on testnets, with every transaction.",
};

// The record is fixed at build time; the live PoolGuard read refreshes at most once a minute.
export const revalidate = 60;

const STATUS_TONE: Record<number, string> = { 0: styles.isOpen, 1: styles.isNarrow, 2: styles.isNarrow, 3: styles.isBlocked };

function Status({ status }: { status: number }) {
  return <span className={`${styles.st} ${STATUS_TONE[status] ?? styles.isBlocked}`}>{statusLabel(reflexPage, status)}</span>;
}

function Tx({ tx: r }: { tx: TxRef | null }) {
  if (!r) return <span className="ds-dim">—</span>;
  return (
    <a className={styles.mono} href={r.url} target="_blank" rel="noreferrer">
      {shortHex(r.tx)}
    </a>
  );
}

function JournalItem({ j, open }: { j: JournalEntry; open: boolean }) {
  const pool = reflexPage.watchedPools[0];
  const marked = j.result === "marked";
  return (
    <li>
      <details open={open} className={styles.ev}>
        <summary>
          <span className={styles.evTime}>{utc(j.at)}</span>
          <span className={styles.mono}>{shortHex(pool.poolId)}</span>
          <span className={styles.evWhat}>
            {marked ? (
              <>
                <Status status={0} /> → <Status status={2} />
              </>
            ) : (
              <span className="ds-dim">{j.result}</span>
            )}
            <span className={styles.mono}>fee_changed · {j.change?.label}</span>
          </span>
          <span className={styles.evTook}>{marked ? `${j.seconds} s · ${j.blocks} blocks` : "—"}</span>
        </summary>
        <ol className={styles.lines}>
          <li>
            <span className={styles.who}>Pool · {reflexPage.chains.origin.name}</span>
            <span>
              Hook emits <b>FeeUpdated</b> {j.change?.label}
            </span>
            <span className={styles.ev2}>
              <Tx tx={j.origin} /> · block {j.origin?.block}
            </span>
          </li>
          <li>
            <span className={styles.who}>Reaction · {reflexPage.chains.reactive.name}</span>
            <span>
              PoolReflex <b>react</b>: fee_changed → narrow, callback requested
            </span>
            <span className={styles.ev2}>
              <Tx tx={j.reactive} /> · block {j.reactive?.block}
              {j.origin ? (
                <>
                  {" · "}
                  <a href={j.origin.reactscan} target="_blank" rel="noreferrer">
                    trace on Reactscan
                  </a>
                </>
              ) : null}
            </span>
          </li>
          <li>
            <span className={styles.who}>Mark · {reflexPage.chains.destination.name}</span>
            <span>
              PoolGuard <b>mark</b> → narrowed (0.1x), {j.seconds} s after the change
            </span>
            <span className={styles.ev2}>
              <Tx tx={j.mark} /> · block {j.mark?.block}
            </span>
          </li>
          <li>
            <span className={styles.who}>Anyone reads</span>
            <span>
              <b>statusOf</b>({shortHex(pool.poolId)}) returns 2 from block {j.mark?.block}
            </span>
            <span className={styles.ev2} />
          </li>
          {j.reopen ? (
            <li>
              <span className={styles.who}>Reopened</span>
              <span>The operator reopened the pool so the next change could be measured</span>
              <span className={styles.ev2}>
                <a className={styles.mono} href={j.reopen.url} target="_blank" rel="noreferrer">
                  {shortHex(j.reopen.tx)}
                </a>
              </span>
            </li>
          ) : null}
        </ol>
      </details>
    </li>
  );
}

export default async function Page() {
  const page = reflexPage;
  const s = summarize(page);
  const live = await readMarksNow(page);
  const marksOn = live ? live.marks.filter((m) => m.status > 0).length : null;
  const journal = journalNewestFirst(page);
  const last = journal.find((j) => j.result === "marked");
  const guard = page.contracts.poolGuard;

  return (
    <main className={`lab-main ${styles.page}`}>
      <header className={styles.head}>
        <p className="lab-eyebrow">Reactive Omni · Every Second Counts</p>
        <h1 className="lab-h1">On-chain reflex</h1>
        <p className="lab-lede">
          When a pool the DeSpell router might use changes a setting, a Reactive contract marks that pool as narrowed on-chain, and
          anyone can read the mark. The router leaves a marked pool out of quotes. These numbers were measured on testnets, with
          every transaction linked.
        </p>
        <dl className={styles.meta}>
          <div>
            <dt>Network</dt>
            <dd>{page.chains.origin.name} (testnet)</dd>
          </div>
          <div>
            <dt>Reaction</dt>
            <dd>{page.chains.reactive.name} (testnet)</dd>
          </div>
          <div>
            <dt>Mark contract</dt>
            <dd>
              <a className={styles.mono} href={guard.url} target="_blank" rel="noreferrer">
                PoolGuard {shortHex(guard.address)}
              </a>
            </dd>
          </div>
          <div>
            <dt>Measured</dt>
            <dd>{utc(page.measuredAt)}</dd>
          </div>
        </dl>
      </header>

      <section aria-labelledby="glance-h" className={styles.section}>
        <h2 id="glance-h" className="lab-h2">
          At a glance
        </h2>
        <dl className={styles.stats}>
          <div>
            <dt>Watched pools</dt>
            <dd>{page.watchedPools.length}</dd>
          </div>
          <div>
            <dt>Marks on now</dt>
            <dd>
              {marksOn ?? "—"}
              <small>{live ? `read from PoolGuard · ${utc(live.readAt)}` : "live read unavailable"}</small>
            </dd>
          </div>
          <div>
            <dt>Change to mark</dt>
            <dd>
              {s.medianSeconds} s
              <small>
                median · n = {s.n} · {rangeLine(s)}
              </small>
            </dd>
          </div>
          <div>
            <dt>Marked within 1 s</dt>
            <dd>
              {s.withinOneSecond}
              <span className={styles.of}> / {s.n}</span>
              <small>
                within 2 s: {s.withinTwoSeconds} / {s.n} · blocks ≈ 0.2 s
              </small>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="marks-h" className={styles.section}>
        <h2 id="marks-h" className="lab-h2">
          Marks
        </h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pool</th>
                <th>Last change</th>
                <th>Change block</th>
                <th>Mark block</th>
                <th>Took</th>
                <th>Mark now</th>
              </tr>
            </thead>
            <tbody>
              {page.watchedPools.map((pool) => {
                const now = live?.marks.find((m) => m.poolId === pool.poolId);
                return (
                  <tr key={pool.poolId}>
                    <td>
                      <span className={styles.mono}>{shortHex(pool.poolId)}</span>
                      <br />
                      <span className="ds-dim">{pool.label}</span>
                    </td>
                    <td>fee {last?.change?.label ?? "—"}</td>
                    <td className={styles.num}>{last?.origin?.block ?? "—"}</td>
                    <td className={styles.num}>{last?.mark?.block ?? "—"}</td>
                    <td className={styles.num}>{last ? `${last.seconds} s · ${last.blocks} blocks` : "—"}</td>
                    <td>{now ? <Status status={now.status} /> : <span className="ds-dim">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={styles.note}>
          Each measured change was marked narrowed and then reopened by the operator, so the pool reads open between runs.
        </p>
      </section>

      <section aria-labelledby="journal-h" className={styles.section}>
        <h2 id="journal-h" className="lab-h2">
          Journal
        </h2>
        <ul className={styles.journal}>
          {journal.map((j, i) => (
            <JournalItem key={j.run} j={j} open={i === 0} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="method-h" className={`${styles.section} ${styles.method}`}>
        <h2 id="method-h" className="lab-h2">
          Method and limits
        </h2>
        <ul>
          <li>
            Testnets only. The pool and PoolGuard are on {page.chains.origin.name} ({page.chains.origin.chainId}); the reaction runs
            on {page.chains.reactive.name} ({page.chains.reactive.chainId}).
          </li>
          <li>
            Change to mark is the time between the fee change&apos;s block and the mark&apos;s block, both on{" "}
            {page.chains.destination.name}. Block times are whole seconds and blocks come about every 0.2 s, so the block gap is
            shown too. Lasna blocks are listed for reference only: the two chains do not share a clock.
          </li>
          <li>
            Marks only tighten. Flipping the fee back is another change, and it narrows the pool again rather than reopening it.
            Only the operator reopens a pool, after its test trades pass; in these runs the operator reopened after each mark so
            the next change could be measured.
          </li>
          <li>
            PoolGuard only records. Quotes and other wallets read it. Neither contract moves anyone&apos;s money.
          </li>
          <li>
            Contracts: hook{" "}
            <a className={styles.mono} href={page.contracts.hook.url} target="_blank" rel="noreferrer">
              {shortHex(page.contracts.hook.address)}
            </a>
            , PoolReflex{" "}
            <a className={styles.mono} href={page.contracts.poolReflex.url} target="_blank" rel="noreferrer">
              {shortHex(page.contracts.poolReflex.address)}
            </a>
            , PoolGuard{" "}
            <a className={styles.mono} href={guard.url} target="_blank" rel="noreferrer">
              {shortHex(guard.address)}
            </a>
            . Source and every hash: the repository&apos;s <code className="ds-mono">reactive/</code> folder.
          </li>
        </ul>
      </section>
    </main>
  );
}
