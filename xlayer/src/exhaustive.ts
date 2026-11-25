// Checks a netlist against the rule function on a range of input vectors, 32 at a time.
// Used by the exhaustive test (split across worker threads) and the build script. Pure module.

import { decodeInput, encodeOutput, OUTPUT_COUNT } from "./bits.ts";
import { evaluate32, scratchFor, type Netlist } from "./netlist.ts";
import { judge } from "./rule.ts";

export type RangeResult = {
  readonly checked: number;
  readonly mismatches: number;
  /** The first input vector where the two differ, with both outputs. */
  readonly first: { readonly vector: number; readonly rule: number; readonly circuit: number } | null;
};

/** Compare vectors [start, end). Both must be multiples of 32. */
export function compareRange(netlist: Netlist, start: number, end: number): RangeResult {
  if (start % 32 !== 0 || end % 32 !== 0 || end < start) throw new RangeError("range must be 32-aligned");
  if (netlist.nOut !== OUTPUT_COUNT) throw new RangeError("not the judgment circuit");
  const scratch = scratchFor(netlist);
  let mismatches = 0;
  let first: RangeResult["first"] = null;
  for (let base = start; base < end; base += 32) {
    const words = evaluate32(netlist, base, scratch);
    for (let j = 0; j < 32; j++) {
      let circuit = 0;
      for (let k = 0; k < OUTPUT_COUNT; k++) circuit |= ((words[k]! >>> j) & 1) << k;
      const vector = base + j;
      const rule = encodeOutput(judge(decodeInput(vector)));
      if (rule !== circuit) {
        mismatches += 1;
        first ??= { vector, rule, circuit };
      }
    }
  }
  return { checked: end - start, mismatches, first };
}
