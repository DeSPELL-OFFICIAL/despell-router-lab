#!/usr/bin/env node
// Turns a latency measurement (scripts/measure.mjs) into
//   1. the data the lab app's "on-chain reflex" page reads: ../deployments/reflex-page.json
//   2. the latency table in ../README.md, between the reflex-latency markers.
//
//   node scripts/report.mjs [measurement.json]          (run from reactive/reflex; reads no keys)
//   LIVE=1 node scripts/report.mjs                      also reads every watched pool's status from PoolGuard now
//
// Only measured numbers go in: nothing here is typed by hand or copied from a design.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCHEMA = "despell-reflex-page/1";
export const STATUS_LABELS = { 0: "open", 1: "small cap", 2: "narrowed (0.1x)", 3: "blocked" };
export const EXPLORERS = {
  84532: { name: "Base Sepolia", tx: "https://sepolia.basescan.org/tx/", address: "https://sepolia.basescan.org/address/" },
  5318007: {
    name: "Reactive Lasna",
    tx: "https://lasna.reactscan.net/tx/",
    address: "https://lasna.reactscan.net/address/",
    // Reactscan finds the reactive transactions an origin-chain transaction triggered, with the callback's progress.
    search: "https://lasna.reactscan.net/search?q=",
  },
};
const README_BEGIN = "<!-- reflex-latency:begin -->";
const README_END = "<!-- reflex-latency:end -->";

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Nearest-rank quantile (q in 0..1). */
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

const share = (xs, pred) => (xs.length ? xs.filter(pred).length / xs.length : null);
const iso = (unix) => (unix == null ? null : new Date(unix * 1000).toISOString());
const pct = (fee) => `${(fee / 10_000).toString()}%`;

/** Builds the page data from a raw measurement. `statuses` (optional) maps poolId -> live status. */
export function buildPage(raw, { generatedAt = new Date().toISOString(), statuses = null } = {}) {
  const origin = raw.origin.chainId;
  const reactive = raw.reactive.chainId;
  const destination = raw.destination.chainId;
  const marked = raw.runs.filter((r) => r.result === "marked");
  const seconds = marked.map((r) => r.seconds);
  const blocks = marked.map((r) => r.blocks);

  const journal = raw.runs.map((r) => ({
    run: r.run,
    at: iso(r.feeTime),
    result: r.result ?? "error",
    change: r.oldFee == null ? null : { kind: "fee_changed", oldFee: r.oldFee, newFee: r.newFee, label: `${pct(r.oldFee)} → ${pct(r.newFee)}` },
    origin: r.feeTx
      ? { tx: r.feeTx, block: r.feeBlock, at: iso(r.feeTime), url: EXPLORERS[origin].tx + r.feeTx, reactscan: EXPLORERS[reactive].search + r.feeTx }
      : null,
    reactive: r.reactive
      ? { tx: r.reactive.tx, block: r.reactive.block, at: iso(r.reactive.time), url: EXPLORERS[reactive].tx + r.reactive.tx }
      : null,
    mark: r.markTx
      ? {
          tx: r.markTx,
          block: r.markBlock,
          at: iso(r.markTime),
          url: EXPLORERS[destination].tx + r.markTx,
          // The status the Marked event set, when the measurement read it (runs measured before it did not).
          ...(Number.isInteger(r.newStatus) ? { newStatus: r.newStatus } : {}),
        }
      : null,
    seconds: r.seconds ?? null,
    blocks: r.blocks ?? null,
    reopen: r.reopenTx ? { tx: r.reopenTx, url: EXPLORERS[destination].tx + r.reopenTx } : null,
  }));

  return {
    schema: SCHEMA,
    generatedAt,
    measuredAt: raw.measuredAt,
    method: raw.method,
    chains: {
      origin: { chainId: origin, name: EXPLORERS[origin].name },
      reactive: { chainId: reactive, name: EXPLORERS[reactive].name },
      destination: { chainId: destination, name: EXPLORERS[destination].name },
    },
    contracts: {
      hook: { address: raw.origin.hook, url: EXPLORERS[origin].address + raw.origin.hook },
      poolReflex: { address: raw.reactive.poolReflex, url: EXPLORERS[reactive].address + raw.reactive.poolReflex },
      poolGuard: { address: raw.destination.poolGuard, url: EXPLORERS[destination].address + raw.destination.poolGuard },
    },
    statusLabels: STATUS_LABELS,
    watchedPools: [{ poolId: raw.origin.poolId, hook: raw.origin.hook, label: "Uniswap v4 ETH/USDC · DynamicFeeHook" }],
    // A snapshot at generation time when LIVE=1; the page can also read statusOf(poolId) itself.
    marksNow: statuses
      ? Object.entries(statuses).map(([poolId, status]) => ({ poolId, status, label: STATUS_LABELS[status] ?? "unknown" }))
      : null,
    latency: {
      runs: raw.runs.length,
      n: marked.length,
      medianSeconds: median(seconds),
      medianBlocks: median(blocks),
      p90Seconds: quantile(seconds, 0.9),
      minSeconds: seconds.length ? Math.min(...seconds) : null,
      maxSeconds: seconds.length ? Math.max(...seconds) : null,
      // "Within the next block" is the page's call: Base Sepolia blocks are about 0.2 s, so the shares are given both
      // by block gap and by seconds (block timestamps are whole seconds).
      shares: {
        withinOneBlock: share(blocks, (b) => b <= 1),
        withinFiveBlocks: share(blocks, (b) => b <= 5),
        withinOneSecond: share(seconds, (s) => s <= 1),
        withinTwoSeconds: share(seconds, (s) => s <= 2),
        withinFiveSeconds: share(seconds, (s) => s <= 5),
      },
    },
    journal,
  };
}

const short = (h) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const link = (x) => (x ? `[\`${short(x.tx)}\`](${x.url})` : "—");

/** The README block (between the markers) for a page object. */
export function readmeBlock(page) {
  const l = page.latency;
  const lines = [
    README_BEGIN,
    `Measured ${page.measuredAt}: ${l.n} of ${l.runs} fee changes marked on PoolGuard. ` +
      `Median ${l.medianSeconds} s (${l.medianBlocks} Base Sepolia blocks), fastest ${l.minSeconds} s, slowest ${l.maxSeconds} s.`,
    "",
    "| # | Fee change | Change (Base Sepolia) | Reaction (Lasna) | Mark (Base Sepolia) | Blocks | Seconds |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...page.journal.map(
      (j) =>
        `| ${j.run} | ${j.change?.label ?? "—"} | ${link(j.origin)} | ${link(j.reactive)} | ${link(j.mark)} | ` +
        // Only a run that marked the pool counts as a latency; anything else shows what happened instead.
        (j.result === "marked" ? `${j.blocks} | ${j.seconds} |` : `— | ${j.result} |`),
    ),
    README_END,
  ];
  return lines.join("\n");
}

/** Replaces the block between the markers, or appends it under a heading if there is none yet. */
export function withReadmeBlock(readme, block) {
  const a = readme.indexOf(README_BEGIN);
  const b = readme.indexOf(README_END);
  if (a !== -1 && b > a) return readme.slice(0, a) + block + readme.slice(b + README_END.length);
  return `${readme.trimEnd()}\n\n### Measured latency\n\n${block}\n`;
}

async function liveStatuses(raw) {
  const res = await fetch("https://sepolia.base.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      // statusOf(bytes32)
      params: [{ to: raw.destination.poolGuard, data: `0xc7df14e2${raw.origin.poolId.slice(2)}` }, "latest"],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return { [raw.origin.poolId]: Number(BigInt(body.result)) };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const input = resolve(here, "..", process.argv[2] ?? "../deployments/reflex-latency-base-sepolia.json");
  const raw = JSON.parse(readFileSync(input, "utf8"));
  const statuses = process.env.LIVE === "1" ? await liveStatuses(raw) : null;
  const page = buildPage(raw, { statuses });
  const pageOut = resolve(here, "../../deployments/reflex-page.json");
  writeFileSync(pageOut, `${JSON.stringify(page, null, 2)}\n`);
  const readmePath = resolve(here, "../../README.md");
  writeFileSync(readmePath, withReadmeBlock(readFileSync(readmePath, "utf8"), readmeBlock(page)));
  console.log(`report: n=${page.latency.n}/${page.latency.runs} · median ${page.latency.medianSeconds} s · ${pageOut}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`report: ${err.message}`);
    process.exit(1);
  });
}
