// Worker thread for compareAll: checks one range and posts the result.

import { parentPort, workerData } from "node:worker_threads";
import { compareRange } from "./exhaustive.ts";
import type { Netlist } from "./netlist.ts";

const { netlist, start, end } = workerData as { netlist: Netlist; start: number; end: number };
parentPort!.postMessage(compareRange(netlist, start, end));
