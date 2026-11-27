#!/usr/bin/env node
// The loop demo: the reflex loop on the test pools, one step at a time, so a screen recording of the app's Reactive
// card can show each step as it lands. Every step waits for a go signal from the recorder, sends one Base Sepolia
// transaction and records the whole loop it starts. The steps, in the order given by STEPS:
//   raise    pool A's fee 0.05% -> 10%: PoolReflex reacts on Lasna, PoolGuard marks A narrowed, the card leaves A out
//   lower    pool A's fee back to 0.05%: another change, so PoolGuard keeps the mark (MarkKept); A stays out
//   reopen   the owner reopens A: the card routes through A again
//   raise-b, lower-b, reopen-b   the same for pool B. With A and B both marked the card has no route.
// STEPS defaults to raise,lower,reopen (pool B stays open the whole time, so the card always has a route). Every pool
// in STEPS needs all three of its steps, in that order, so a run that finishes leaves both pools open at 0.05%.
//
//   node --env-file=<env file> ../scripts/with-key.mjs -- node scripts/loop-demo.mjs      (run from reactive/reflex)
//
// Inputs (environment): PRIVATE_KEY (the hook and PoolGuard owner; only the forge child processes read it), GUARD and
// REFLEX (the deployed contracts), SIGNAL_DIR (each step waits until <SIGNAL_DIR>/<step>.go exists, up to
// WAIT_MINUTES, default 30), STEPS, OUT (default ../deployments/loop-demo-base-sepolia.json). CHECK_ONLY=1 runs the
// read-only checks and stops before sending; it needs no key.
//
// Every run that passes the checks replaces OUT. The default path holds the committed record of the first demo video's
// run, so give a new run its own OUT, or copy the old record first, to keep both.
//
// One Base Sepolia transaction from the owner per step. The reactions (Lasna) and the marks (Base Sepolia) come from
// Reactive Network. The record is written after every step. Neither the record nor the output names a path on this
// machine, since the output is shown in the demo video.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_RPC,
  blockOf,
  feeOf,
  findReaction,
  forgeSend,
  HOOK,
  LASNA_RPC,
  latest,
  POOL_B_ID,
  POOL_ID,
  precheck,
  sleep,
  statusInLog,
  statusOf,
  waitForMark,
} from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLEX_DIR = resolve(HERE, "..");
const POOL_DIR = resolve(HERE, "../..");

const LOW_FEE = 500; // 0.05%
const HIGH_FEE = 100_000; // 10%
const MARK_TIMEOUT_MS = 180_000;
const REACTION_TIMEOUT_MS = 60_000;
const LREACT_PER_REACTION = 20_000_000_000_000_000n; // 0.02 lREACT
const GAS_WEI_PER_STEP = 50_000_000_000_000n; // 0.00005 ETH per transaction, with room
const POOLS = {
  A: { id: POOL_ID, name: "pool A", tickSpacing: "10" },
  B: { id: POOL_B_ID, name: "pool B", tickSpacing: "60" },
};
const STATUS = ["open", "small cap", "narrowed", "blocked"];
const fee = (f) => `${f / 10_000}%`;
const eth = (wei) => `${(Number(wei) / 1e18).toFixed(6)}`;

const env = process.env;
const GUARD = must("GUARD");
const REFLEX = must("REFLEX");
const SIGNAL_DIR = env.SIGNAL_DIR ? resolve(env.SIGNAL_DIR) : fail("SIGNAL_DIR must be set");
const WAIT_MS = Number(env.WAIT_MINUTES ?? 30) * 60_000;
const OUT = resolve(REFLEX_DIR, env.OUT ?? "../deployments/loop-demo-base-sepolia.json");
if (!(WAIT_MS > 0)) fail("WAIT_MINUTES must be a positive number");
const STEPS = parseSteps(env.STEPS ?? "raise,lower,reopen");

function must(name) {
  const v = env[name];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail(`${name} must be an address`);
  return v;
}
function fail(msg) {
  console.error(`loop-demo: ${msg}`);
  process.exit(2);
}

/** "raise,raise-b,..." -> [{ name, kind, pool }]. Each pool used needs raise, lower and reopen, in that order. */
function parseSteps(text) {
  const steps = text.split(",").map((s) => s.trim()).filter(Boolean).map((name) => {
    const m = /^(raise|lower|reopen)(?:-(b))?$/.exec(name);
    if (!m) fail(`unknown step ${name} (steps: raise, lower, reopen, raise-b, lower-b, reopen-b)`);
    return { name, kind: m[1], pool: m[2] ? "B" : "A" };
  });
  if (new Set(steps.map((s) => s.name)).size !== steps.length) fail("a step is listed twice");
  for (const pool of new Set(steps.map((s) => s.pool))) {
    const order = steps.filter((s) => s.pool === pool).map((s) => s.kind).join(",");
    if (order !== "raise,lower,reopen") fail(`pool ${pool} needs raise, lower and reopen in that order, not ${order}`);
  }
  return steps;
}

const record = {
  startedAt: new Date().toISOString(),
  origin: { chain: "Base Sepolia", chainId: 84532, hook: HOOK, pool: POOL_ID, poolB: POOL_B_ID },
  reactive: { chain: "Reactive Lasna", chainId: 5318007, poolReflex: REFLEX },
  destination: { chain: "Base Sepolia", chainId: 84532, poolGuard: GUARD },
  method: "seconds = PoolGuard answer block timestamp - change block timestamp (whole seconds); blocks = Base Sepolia block gap (about 0.2 s each)",
  plan: STEPS.map((s) => s.name),
  steps: [],
};
const save = () => writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
const log = (msg) => console.log(`loop-demo: ${msg}`);
// Shown in the video: a path inside the repository, or only the file name.
const shownPath = (p) => (relative(POOL_DIR, p).startsWith("..") ? basename(p) : relative(POOL_DIR, p));

/** Waits until the recorder says go (<SIGNAL_DIR>/<step>.go), or WAIT_MS passes. */
async function waitForGo(step) {
  const signal = join(SIGNAL_DIR, `${step}.go`);
  // The record is committed: it names the step, never a path on this machine.
  record.waitingFor = { step, since: new Date().toISOString() };
  save();
  log(`waiting for the go for ${step} (up to ${WAIT_MS / 60_000} min)`);
  const until = Date.now() + WAIT_MS;
  while (!existsSync(signal) && Date.now() < until) await sleep(500);
  delete record.waitingFor;
  save();
  return existsSync(signal);
}

/** Sends one forge script and records its transaction under `name`. */
async function send(s, what, cwd, script, extraEnv) {
  const lasnaFrom = (await latest(LASNA_RPC)) - 20;
  const sent = await forgeSend(cwd, script, "base_sepolia", extraEnv);
  const block = await blockOf(BASE_RPC, sent.block);
  const step = { step: s.name, pool: s.pool, tx: sent.hash, block: block.number, time: block.time };
  record.steps.push(step);
  save();
  log(`${s.name}: ${what} · tx ${sent.hash} · block ${block.number}`);
  return { step, lasnaFrom };
}

/** Records the loop a fee change starts: PoolGuard's answer on Base Sepolia and PoolReflex's reaction on Lasna. */
async function loop(step, pool, lasnaFrom) {
  const { found } = await waitForMark({ guard: GUARD, pool: pool.id, originTx: step.tx, fromBlock: step.block, timeoutMs: MARK_TIMEOUT_MS });
  if (!found) {
    step.answer = { result: `no answer within ${MARK_TIMEOUT_MS / 1000} s` };
    save();
    log(`  -> no answer from PoolGuard within ${MARK_TIMEOUT_MS / 1000} s`);
    return step.answer;
  }
  const mark = await blockOf(BASE_RPC, Number(found.log.blockNumber));
  step.answer = {
    result: found.kind,
    tx: found.log.transactionHash,
    block: mark.number,
    time: mark.time,
    status: statusInLog(found.log),
    blocks: mark.number - step.block,
    seconds: mark.time - step.time,
  };
  save();
  const did = found.kind === "marked" ? `marked ${pool.name} ${STATUS[step.answer.status]}` : `kept ${pool.name} ${STATUS[step.answer.status]} (MarkKept)`;
  log(`  -> PoolGuard ${did} · tx ${step.answer.tx} · block ${mark.number} · ${step.answer.seconds} s / ${step.answer.blocks} blocks after the change`);
  // Lasna's logs can lag the callback; the answer above is what the card waits for, so this lookup comes after it.
  const until = Date.now() + REACTION_TIMEOUT_MS;
  while (!step.reaction && Date.now() < until) {
    step.reaction = await findReaction({ reflex: REFLEX, pool: pool.id, originTx: step.tx, fromBlock: lasnaFrom }).catch(() => null);
    if (!step.reaction) await sleep(2_000);
  }
  save();
  log(`  -> it came from PoolReflex.react on Reactive Lasna · ${step.reaction ? `tx ${step.reaction.tx} · block ${step.reaction.block}` : "not found yet"}`);
  return step.answer;
}

function stop(msg) {
  record.stopped = msg;
  save();
  throw new Error(msg);
}

async function run(s) {
  const pool = POOLS[s.pool];
  if (s.kind === "raise") {
    const raised = await send(s, `${pool.name} fee ${fee(LOW_FEE)} -> ${fee(HIGH_FEE)}`, POOL_DIR, "script/SetFee.s.sol", {
      HOOK,
      NEW_FEE: String(HIGH_FEE),
      TICK_SPACING: pool.tickSpacing,
    });
    if ((await loop(raised.step, pool, raised.lasnaFrom)).result !== "marked") {
      stop(`${pool.name} was not marked after its fee change; ${pool.name} is left at 10%, and a late answer may still mark it`);
    }
  } else if (s.kind === "lower") {
    // Another change, so PoolGuard keeps the pool narrowed. Wait for that answer before reopening, or a late callback
    // would mark the pool again after the reopen.
    const lowered = await send(s, `${pool.name} fee ${fee(HIGH_FEE)} -> ${fee(LOW_FEE)}`, POOL_DIR, "script/SetFee.s.sol", {
      HOOK,
      NEW_FEE: String(LOW_FEE),
      TICK_SPACING: pool.tickSpacing,
    });
    if ((await loop(lowered.step, pool, lowered.lasnaFrom)).result.startsWith("no answer")) {
      stop(`no answer to ${pool.name}'s fee change back; ${pool.name} is left at 0.05% and marked. Not reopening it, or the late answer would mark it again after`);
    }
  } else {
    await send(s, `PoolGuard.reopen(${pool.name}), owner only`, REFLEX_DIR, "script/Reopen.s.sol", { GUARD, POOL_ID: pool.id });
  }
}

async function main() {
  log(`hook ${HOOK} · PoolGuard ${GUARD} · PoolReflex ${REFLEX}`);
  log(`pool A ${POOL_ID} · pool B ${POOL_B_ID}`);
  const used = new Set(STEPS.map((s) => s.pool));
  for (const key of Object.keys(POOLS)) {
    const pool = POOLS[key];
    const [f, st] = [await feeOf(pool.id), await statusOf(GUARD, pool.id)];
    if (used.has(key) && f !== LOW_FEE) fail(`${pool.name}'s fee is ${f}, not ${LOW_FEE}; set it back first`);
    if (st !== 0) fail(`${pool.name} is marked; reopen it first${used.has(key) ? "" : ", or the card has no route while the other pool is out"}`);
  }
  const reactions = BigInt(STEPS.filter((s) => s.kind !== "reopen").length);
  const checks = await precheck({ guard: GUARD, reflex: REFLEX, lreactNeeded: LREACT_PER_REACTION * reactions, ethNeeded: GAS_WEI_PER_STEP * BigInt(STEPS.length) });
  if (checks.problems.length) fail(`not starting:\n  - ${checks.problems.join("\n  - ")}`);
  log(`checks passed · owner ${checks.owner} has ${eth(checks.ownerEth)} ETH · PoolReflex funds ${eth(checks.reflexFunds)} lREACT · PoolGuard funds ${eth(checks.guardFunds)} ETH`);
  log(`both pools open at ${fee(LOW_FEE)} · steps: ${STEPS.map((s) => s.name).join(" -> ")}`);
  if (env.CHECK_ONLY === "1") {
    log("CHECK_ONLY=1: nothing sent");
    process.exit(0);
  }
  // A signal left from an earlier run would start a step before the recorder is ready. Cleared only once the checks
  // pass, so a second run started by mistake stops before it touches a running demo's signals.
  mkdirSync(SIGNAL_DIR, { recursive: true });
  for (const s of STEPS) rmSync(join(SIGNAL_DIR, `${s.name}.go`), { force: true });
  log(`record: ${shownPath(OUT)} (replaces any earlier record there)`);
  save();

  for (const [i, s] of STEPS.entries()) {
    if (!(await waitForGo(s.name))) stop(i === 0 ? `no go for ${s.name}; nothing sent` : `no go for ${s.name}; the end line says what is left`);
    await run(s);
  }
}

main()
  .catch((err) => {
    console.error(`loop-demo: ${err.message}`);
    record.error = err.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      record.end = {
        feeA: await feeOf(POOL_ID),
        statusA: await statusOf(GUARD, POOL_ID),
        feeB: await feeOf(POOL_B_ID),
        statusB: await statusOf(GUARD, POOL_B_ID),
        at: new Date().toISOString(),
      };
      const e = record.end;
      log(`end · pool A fee ${fee(e.feeA)}, ${STATUS[e.statusA]} · pool B fee ${fee(e.feeB)}, ${STATUS[e.statusB]}`);
    } catch (err) {
      log(`could not read the end state: ${err.message}`);
    }
    save();
  });
