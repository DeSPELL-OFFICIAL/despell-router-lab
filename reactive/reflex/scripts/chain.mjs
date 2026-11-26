// Shared by measure.mjs, route-demo.mjs and loop-demo.mjs: plain JSON-RPC reads on Base Sepolia and Lasna, forge runs
// that send one script's transactions, and the lookups for PoolReflex's reaction and PoolGuard's answer to a pool
// change. Nothing here holds a key: forge reads PRIVATE_KEY from the environment that scripts/with-key.mjs gives the
// parent process.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_RPC = "https://sepolia.base.org";
export const LASNA_RPC = "https://lasna-rpc.rnk.dev/";
export const HOOK = "0x18813Bc0B1954490e751e6800Ae5E9d8C5D09000";
/** Test pool A (tick spacing 10), the one the latency runs measure. */
export const POOL_ID = "0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4";
/** Test pool B (tick spacing 60), on the same hook (reactive/script/LaunchSecondPool.s.sol). */
export const POOL_B_ID = "0xa7692fed527766fb44a78fb84faffa4cc759bb29002969b87e571366db28efc2";

export const MARKED = "0x1fbdf06b61329fded54e41081a1d0978d7424d8c8d6a9489fa9bd86861f39b10"; // Marked(bytes32,uint8,uint8,bytes32,uint256,bytes32)
export const MARK_KEPT = "0x5a28ba2feb33e6ddddbe0230f1d37665ca9e6bf067fd29973162c1b687299832"; // MarkKept(bytes32,uint8,uint8,bytes32,bytes32)
export const REFLEX_EVENT = "0xbb824a41bd5e2eb86b446be13af337241bc47e64fc7a8f0c55cc730574c355d2"; // Reflex(bytes32,bytes32,uint8,uint24,uint24,uint256,bytes32)
export const FEE_OF = "0x430062bd"; // feeOf(bytes32)
export const STATUS_OF = "0xc7df14e2"; // statusOf(bytes32)
export const OWNER = "0x8da5cb5b"; // owner()
export const GUARD_OF = "0x7ceab3b1"; // guard()
export const DEBT = "0x9b6c56ec"; // debt(address)
export const RESERVES = "0xd66bd524"; // reserves(address)
export const CALLBACK_SENDER = "0x1dc18e11"; // _CALLBACK_SENDER()
export const CALLBACK_PROXY = "0x476F44b11F5C942c58f4c8E3d0300E5710743585"; // Reactive's callback proxy on Base Sepolia
export const SYSTEM = "0x8888888888888888888888888888888888888888"; // Reactive's system contract on Lasna

/** Public RPCs refuse eth_getLogs over more than about 200 blocks; stay under it. */
export const LOG_WINDOW = 150;
/** Each poll reads the last blocks again, in case a node answered before it had them. */
export const LOG_OVERLAP = 25;
export const POLL_MS = 1_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hex = (n) => `0x${n.toString(16)}`;
export const pad32 = (h) => h.replace(/^0x/, "").padStart(64, "0");

export async function rpc(url, method, params, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(500 * i);
    }
  }
}
export const call = (url, to, data) => rpc(url, "eth_call", [{ to, data }, "latest"]);
export const blockOf = async (url, n) => {
  const b = await rpc(url, "eth_getBlockByNumber", [hex(n), false]);
  return { number: Number(b.number), time: Number(b.timestamp) };
};
export const latest = async (url) => Number(await rpc(url, "eth_blockNumber", []));
export const word = async (url, to, data) => BigInt(await call(url, to, data));
export const addressAt = async (url, to, data) => `0x${(await call(url, to, data)).slice(-40)}`.toLowerCase();
export const balance = async (url, who) => BigInt(await rpc(url, "eth_getBalance", [who, "latest"]));

export const feeOf = async (pool) => Number(await word(BASE_RPC, HOOK, FEE_OF + pad32(pool)));
export const statusOf = async (guard, pool) => Number(await word(BASE_RPC, guard, STATUS_OF + pad32(pool)));

/** eth_getLogs over [from, to], one window of at most LOG_WINDOW blocks at a time. */
export async function logsRange(url, address, topics, from, to) {
  const found = [];
  for (let a = from; a <= to; a += LOG_WINDOW) {
    const b = Math.min(a + LOG_WINDOW - 1, to);
    found.push(...(await rpc(url, "eth_getLogs", [{ address, fromBlock: hex(a), toBlock: hex(b), topics }])));
  }
  return found;
}

/**
 * PoolReflex's reactive transaction on Lasna for one pool change: its Reflex event carries the pool and the origin
 * transaction. Returns { tx, block, time } or null when Lasna has not shown it yet.
 */
export async function findReaction({ reflex, pool, originTx, fromBlock }) {
  const found = await logsRange(LASNA_RPC, reflex, [REFLEX_EVENT, `0x${pad32(pool)}`, originTx], fromBlock, await latest(LASNA_RPC));
  if (!found.length) return null;
  const b = await blockOf(LASNA_RPC, Number(found[0].blockNumber));
  return { tx: found[0].transactionHash, block: b.number, time: b.time };
}

/** One line for the record: the first error line of a tool's output, with file paths taken out. */
export function oneLine(text) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|revert|fail/i.test(l)) ?? lines[0] ?? "";
  return line.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/:'"]+){2,}[\\/]?/g, "<path>").slice(0, 200);
}

/**
 * Runs one forge script that sends transactions and returns their receipts from the broadcast record:
 * { hash, block } of the last one, and `all` in order.
 */
export function forgeSend(cwd, script, rpcAlias, extraEnv, flags = []) {
  return new Promise((resolveRun, reject) => {
    const args = ["script", script, "--rpc-url", rpcAlias, "--broadcast", ...flags];
    const child = spawn("forge", args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`forge ${script}: ${oneLine(out)}`));
      const chain = rpcAlias === "lasna" ? 5318007 : 84532;
      const record = join(cwd, "broadcast", script.replace(/^script\//, ""), String(chain), "run-latest.json");
      const { receipts } = JSON.parse(readFileSync(record, "utf8"));
      const failed = receipts.find((r) => Number(r.status) !== 1);
      if (failed) return reject(new Error(`${script}: transaction ${failed.transactionHash} failed`));
      const all = receipts.map((r) => ({ hash: r.transactionHash, block: Number(r.blockNumber) }));
      resolveRun({ ...all.at(-1), all });
    });
  });
}

/** The status PoolGuard set or kept: Marked's newStatus (second data word) or MarkKept's status (first). */
export function statusInLog(log) {
  const at = log.topics[0] === MARKED ? 1 : 0;
  return Number(BigInt(`0x${log.data.slice(2 + 64 * at, 2 + 64 * (at + 1))}`));
}

/**
 * Waits for PoolGuard's Marked or MarkKept for this pool change. Scans forward from `fromBlock`: each poll reads the
 * new blocks plus the last LOG_OVERLAP blocks again. Returns { found, cursor }: cursor is the next unread block.
 */
export async function waitForMark({ guard, pool, originTx, fromBlock, timeoutMs }) {
  let cursor = fromBlock;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const head = await latest(BASE_RPC);
    if (head >= cursor) {
      const from = Math.max(fromBlock, cursor - LOG_OVERLAP);
      const hits = await logsRange(BASE_RPC, guard, [[MARKED, MARK_KEPT], `0x${pad32(pool)}`, originTx], from, head);
      if (hits.length) return { found: { kind: hits[0].topics[0] === MARKED ? "marked" : "kept", log: hits[0] }, cursor };
      cursor = head + 1;
    }
    await sleep(POLL_MS);
  }
  return { found: null, cursor };
}

/**
 * Checks the wiring, owners, debts and funds before anything is sent. Returns { problems, owner, reflexFunds,
 * guardFunds }; the caller stops when problems is not empty.
 */
export async function precheck({ guard, reflex, lreactNeeded, ethNeeded }) {
  const problems = [];
  const wired = await addressAt(LASNA_RPC, reflex, GUARD_OF);
  if (wired !== guard.toLowerCase()) problems.push(`PoolReflex.guard() is ${wired}, not PoolGuard ${guard}`);
  const sender = await addressAt(BASE_RPC, guard, CALLBACK_SENDER);
  if (sender !== reflex.toLowerCase()) problems.push(`PoolGuard accepts marks from ${sender}, not PoolReflex ${reflex}`);
  const hookOwner = await addressAt(BASE_RPC, HOOK, OWNER);
  const guardOwner = await addressAt(BASE_RPC, guard, OWNER);
  if (hookOwner !== guardOwner) problems.push("the hook and PoolGuard have different owners; one key must change fees and reopen");
  if ((await word(BASE_RPC, CALLBACK_PROXY, DEBT + pad32(guard))) > 0n) problems.push("PoolGuard owes the callback proxy");
  if ((await word(LASNA_RPC, SYSTEM, DEBT + pad32(reflex))) > 0n) problems.push("PoolReflex owes the system contract");
  const reflexFunds = (await balance(LASNA_RPC, reflex)) + (await word(LASNA_RPC, SYSTEM, RESERVES + pad32(reflex)));
  if (reflexFunds < lreactNeeded) problems.push(`PoolReflex has ${reflexFunds} wei lREACT, short of ${lreactNeeded}`);
  const guardFunds = (await balance(BASE_RPC, guard)) + (await word(BASE_RPC, CALLBACK_PROXY, RESERVES + pad32(guard)));
  if (guardFunds === 0n) problems.push("PoolGuard has nothing to pay callbacks with");
  const ownerEth = await balance(BASE_RPC, hookOwner);
  if (ownerEth < ethNeeded) problems.push(`the owner has ${ownerEth} wei on Base Sepolia, short of ${ethNeeded}`);
  return { problems, owner: hookOwner, ownerEth, reflexFunds, guardFunds };
}
