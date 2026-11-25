// Runs compareRange over every input vector, split across worker threads.

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { INPUT_COUNT } from "./bits.ts";
import type { RangeResult } from "./exhaustive.ts";
import type { Netlist } from "./netlist.ts";

export type AllResult = RangeResult & { readonly combinations: number; readonly threads: number; readonly ms: number };

export async function compareAll(netlist: Netlist, threads = Math.max(1, Math.min(16, availableParallelism()))): Promise<AllResult> {
  const combinations = 2 ** INPUT_COUNT;
  const chunk = Math.ceil(combinations / threads / 32) * 32;
  const started = performance.now();
  const workers: Worker[] = [];
  const runs: Promise<RangeResult>[] = [];
  for (let start = 0; start < combinations; start += chunk) {
    const end = Math.min(combinations, start + chunk);
    const worker = new Worker(new URL("./exhaustive-worker.ts", import.meta.url), { workerData: { netlist, start, end } });
    workers.push(worker);
    runs.push(
      new Promise<RangeResult>((resolve, reject) => {
        worker.once("message", (result: RangeResult) => resolve(result));
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`worker for [${start}, ${end}) stopped with code ${code}`));
        });
      }),
    );
  }
  let results: RangeResult[];
  try {
    results = await Promise.all(runs);
  } catch (error) {
    // One worker failed: stop the others instead of waiting for their whole ranges.
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    throw error;
  }
  let checked = 0;
  let mismatches = 0;
  let first: RangeResult["first"] = null;
  for (const result of results) {
    checked += result.checked;
    mismatches += result.mismatches;
    if (first === null && result.first !== null) first = result.first;
  }
  return { checked, mismatches, first, combinations, threads: results.length, ms: Math.round(performance.now() - started) };
}
