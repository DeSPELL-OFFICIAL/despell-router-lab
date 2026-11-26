// Replays the router journal's past patrol steps through the pool judgment circuit. Read only, no key.
//
//   node scripts/replay-journal.ts --file <export.json> [--chain [--processor 0x… --id N]] [--out <report.txt>]
//
// <export.json> is the journal in the export shape (src/journal.ts, `JournalExport`). It is made outside this
// repository by whoever can read the journal; nothing here connects to a database.
// Without --chain the committed netlist (circuit/pool-judgment.json) is evaluated here. With --chain every distinct
// input is sent to `eval` on X Layer, after the circuit's info and netlist are read back and found equal to the
// committed ones (the taped-out circuit by default). XLAYER_RPC overrides the public RPC.
// Prints "M of N judged patrol steps …", the other kinds of step, every difference, every step that could not be
// replayed and every step judged by a rule newer than the circuit.
// Exit 0: no replayed step differs. 1: one does. 2: bad arguments or input, or the chain could not be asked
// (src/replay-command.ts).

import { readFileSync, writeFileSync } from "node:fs";
import { X_LAYER_PUBLIC_RPC, XLayerReader } from "../src/onchain.ts";
import { replayCommand } from "../src/replay-command.ts";

const result = await replayCommand(process.argv.slice(2), {
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => writeFileSync(path, text),
  reader: () => new XLayerReader(process.env.XLAYER_RPC ?? X_LAYER_PUBLIC_RPC),
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(`${result.stderr}\n`);
process.exit(result.code);
