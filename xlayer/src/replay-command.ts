// The replay command (scripts/replay-journal.ts), apart from the process so its exit codes can be tested.
//
// Exit codes:
//   0  every replayed step gives the server's stage;
//   1  a replayed step differs (the report lists it);
//   2  nothing trustworthy to report: bad arguments, an export that fails its checks, or, with --chain, a chain that
//      is not X Layer, no circuit at that id, an address with no code, a circuit that is not the committed one, or an
//      RPC failure part way. A 2 is never a difference.

import { ARTIFACT_URL } from "./artifact.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./bits.ts";
import { parseJournalExport, type JournalExport } from "./journal.ts";
import { decodeNetlist, evaluate, fromHex, toHex } from "./netlist.ts";
import { TAPED_OUT, X_LAYER_CHAIN_ID, type XLayerReader } from "./onchain.ts";
import { formatReplay, replayJournal, type CircuitJudge } from "./replay.ts";

export const REPLAY_USAGE = "Usage: node scripts/replay-journal.ts --file <export.json> [--chain [--processor 0x… --id N]] [--out <report.txt>]";

export type ReplayCommandDeps = {
  readonly readText: (path: string | URL) => string;
  readonly writeText: (path: string, text: string) => void;
  /** The X Layer reader for --chain (XLAYER_RPC or the public RPC). */
  readonly reader: () => XLayerReader;
};

export type ReplayCommandResult = { readonly code: 0 | 1 | 2; readonly stdout: string; readonly stderr: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function replayCommand(argv: readonly string[], deps: ReplayCommandDeps): Promise<ReplayCommandResult> {
  const fail = (stderr: string): ReplayCommandResult => ({ code: 2, stdout: "", stderr });
  const arg = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const file = arg("file");
  const onChain = argv.includes("--chain");
  const processor = arg("processor") ?? TAPED_OUT.processor;
  const idText = arg("id") ?? String(TAPED_OUT.circuitId);
  const out = arg("out");
  if (!file || !/^0x[0-9a-fA-F]{40}$/u.test(processor) || !/^[1-9][0-9]{0,9}$/u.test(idText)) return fail(REPLAY_USAGE);

  let journal: JournalExport;
  try {
    journal = parseJournalExport(JSON.parse(deps.readText(file)));
  } catch (error) {
    return fail(`cannot read ${file}: ${message(error)}`);
  }

  const artifact = JSON.parse(deps.readText(ARTIFACT_URL)) as { nIn: number; nOut: number; nand: number; netlist: string };
  let circuit: CircuitJudge;
  let source: string;
  if (onChain) {
    const reader = deps.reader();
    const id = Number(idText);
    try {
      const chainId = await reader.chainId();
      if (chainId !== X_LAYER_CHAIN_ID) return fail(`the RPC is chain ${chainId}, not X Layer (${X_LAYER_CHAIN_ID}); nothing is replayed`);
      const info = await reader.circuitInfo(processor, id);
      const same = toHex(await reader.netlist(processor, id)) === artifact.netlist;
      if (!same || info.nIn !== INPUT_COUNT || info.nOut !== OUTPUT_COUNT || info.nState !== 0 || info.gateCount !== artifact.nand) {
        return fail(`circuit #${id} on ${processor} is not the committed pool judgment circuit; nothing is replayed`);
      }
      source = `eval on X Layer (chain ${chainId}), processor ${processor}, circuit #${id}`;
    } catch (error) {
      return fail(`no committed circuit to ask at ${processor} #${id} (no circuit, no code, or the RPC failed): ${message(error)}`);
    }
    circuit = (vector) => reader.evalVector(processor, id, vector, INPUT_COUNT, OUTPUT_COUNT);
  } else {
    const netlist = decodeNetlist(fromHex(artifact.netlist), artifact.nIn, artifact.nOut);
    circuit = (vector) => evaluate(netlist, vector);
    source = "the committed netlist, evaluated here (circuit/pool-judgment.json)";
  }

  let report;
  try {
    report = await replayJournal(journal, circuit);
  } catch (error) {
    return fail(`the replay stopped part way, so it reports nothing: ${message(error)}`);
  }
  const text = `${formatReplay(report)}\ncircuit: ${source}\nexport: ${journal.lines.length} lines, ${journal.pools.length} pools with a card\n`;
  if (out) deps.writeText(out, text);
  return { code: report.differences.length === 0 ? 0 : 1, stdout: text, stderr: "" };
}
