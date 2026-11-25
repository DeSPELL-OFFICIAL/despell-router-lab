// TapeOut netlists: a small NAND builder, the on-chain byte format, and two evaluators.
//
// Format (TapeOut, as documented by the OrderGuard XL reference implementation and checked against X Layer, README):
//   - Signal 0 is constant 0, signal 1 is constant 1, signals 2 … 2+nIn-1 are the inputs.
//   - Gate i drives signal 2+nIn+i. A NAND is 7 bytes: 0x00, then two big-endian u24 signal numbers.
//     A gate may only read signals below its own (no loops), so the list is in topological order.
//   - The last nOut signals are the outputs, in pin order.
// Only NAND gates are used here (no LATCH, no sub-circuit REF), so the circuit has no state.
//
// Pure module.

export type Gate = readonly [number, number];

export type Netlist = {
  readonly nIn: number;
  readonly nOut: number;
  /** Gate i reads signals gates[i][0] and gates[i][1] and drives signal 2 + nIn + i. */
  readonly gates: readonly Gate[];
};

export const CONST0 = 0;
export const CONST1 = 1;

/**
 * Builds a NAND network with constant folding, double negation removal and structural hashing (the same NAND is
 * made once). Signals are numbers; inputs are 2 … 2+nIn-1.
 */
export class NandBuilder {
  readonly nIn: number;
  private readonly gates: Gate[] = [];
  private readonly byInputs = new Map<string, number>();
  /** signal → its complement, when the builder made one from the other. */
  private readonly complement = new Map<number, number>();

  constructor(nIn: number) {
    this.nIn = nIn;
  }

  input(pin: number): number {
    if (!Number.isInteger(pin) || pin < 0 || pin >= this.nIn) throw new RangeError(`no input pin ${pin}`);
    return 2 + pin;
  }

  nand(a: number, b: number): number {
    if (a === CONST0 || b === CONST0) return CONST1;
    if (a === CONST1) return this.not(b);
    if (b === CONST1) return this.not(a);
    if (a === b) return this.not(a);
    if (this.complement.get(a) === b) return CONST1;
    return this.raw(a, b);
  }

  not(a: number): number {
    if (a === CONST0) return CONST1;
    if (a === CONST1) return CONST0;
    const known = this.complement.get(a);
    if (known !== undefined) return known;
    const out = this.raw(a, a);
    this.complement.set(a, out);
    this.complement.set(out, a);
    return out;
  }

  and(a: number, b: number): number {
    return this.not(this.nand(a, b));
  }

  or(a: number, b: number): number {
    return this.nand(this.not(a), this.not(b));
  }

  andAll(signals: readonly number[]): number {
    return this.tree(signals, CONST1, (a, b) => this.and(a, b));
  }

  orAll(signals: readonly number[]): number {
    return this.tree(signals, CONST0, (a, b) => this.or(a, b));
  }

  /** sel ? whenOne : whenZero, folding constant arms. */
  mux(sel: number, whenOne: number, whenZero: number): number {
    if (whenOne === whenZero) return whenOne;
    if (whenOne === CONST1 && whenZero === CONST0) return sel;
    if (whenOne === CONST0 && whenZero === CONST1) return this.not(sel);
    if (whenOne === CONST0) return this.and(this.not(sel), whenZero);
    if (whenOne === CONST1) return this.or(sel, whenZero);
    if (whenZero === CONST0) return this.and(sel, whenOne);
    if (whenZero === CONST1) return this.or(this.not(sel), whenOne);
    return this.nand(this.nand(sel, whenOne), this.nand(this.not(sel), whenZero));
  }

  /**
   * A function of a few signals given by its truth table: `table(code)` for each code of `signals` (signals[0] is
   * the low bit). Built by Shannon expansion on the high bit first, folding constants as it goes.
   */
  lookup(signals: readonly number[], table: (code: number) => boolean): number {
    const expand = (depth: number, prefix: number): number => {
      if (depth < 0) return table(prefix) ? CONST1 : CONST0;
      const whenOne = expand(depth - 1, prefix | (1 << depth));
      const whenZero = expand(depth - 1, prefix);
      return this.mux(signals[depth]!, whenOne, whenZero);
    };
    return expand(signals.length - 1, 0);
  }

  /**
   * Finish with `outputs` as the last signals, in pin order. Each output becomes one last gate: a gate output is
   * re-made at the end from the same two inputs, and an input or constant x becomes NAND(NOT x, NOT x). An output
   * gate that nothing else reads is then only made once, at the end. Gates no output needs are dropped.
   */
  finish(outputs: readonly number[]): Netlist {
    const base = 2 + this.nIn;
    const gateOf = (signal: number) => this.gates[signal - base]!;
    const tails: Gate[] = outputs.map((output) => {
      if (output >= base) return gateOf(output);
      const inverse = this.not(output);
      return [inverse, inverse];
    });

    // The body is every gate the tails read, directly or not. Builder order is already topological.
    const body = new Set<number>();
    const visit = (signal: number) => {
      if (signal < base || body.has(signal)) return;
      body.add(signal);
      const [a, b] = gateOf(signal);
      visit(a);
      visit(b);
    };
    for (const [a, b] of tails) {
      visit(a);
      visit(b);
    }

    const renumber = new Map<number, number>();
    for (let signal = 0; signal < base; signal++) renumber.set(signal, signal);
    const place = (signal: number) => {
      const placed = renumber.get(signal);
      if (placed === undefined) throw new Error(`signal ${signal} is read before it is placed`);
      return placed;
    };
    const gates: Gate[] = [];
    for (const signal of [...body].sort((x, y) => x - y)) {
      const [a, b] = gateOf(signal);
      gates.push([place(a), place(b)]);
      renumber.set(signal, base + gates.length - 1);
    }
    for (const [a, b] of tails) gates.push([place(a), place(b)]);
    return { nIn: this.nIn, nOut: outputs.length, gates };
  }

  private raw(a: number, b: number): number {
    const [low, high] = a < b ? [a, b] : [b, a];
    const key = `${low},${high}`;
    const known = this.byInputs.get(key);
    if (known !== undefined) return known;
    this.gates.push([low, high]);
    const signal = 2 + this.nIn + this.gates.length - 1;
    this.byInputs.set(key, signal);
    return signal;
  }

  private tree(signals: readonly number[], empty: number, join: (a: number, b: number) => number): number {
    if (signals.length === 0) return empty;
    let layer = [...signals];
    while (layer.length > 1) {
      const next: number[] = [];
      for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? join(layer[i]!, layer[i + 1]!) : layer[i]!);
      layer = next;
    }
    return layer[0]!;
  }
}

// ── Byte format ─────────────────────────────────────────────────────────────────────────────────────────────────

const U24_MAX = 0xff_ff_ff;
const NAND_OPCODE = 0x00;
const NAND_BYTES = 7;

/** Encode a netlist as the bytes `tapeout(nl, nIn, nOut)` takes. Checks every gate reads only earlier signals. */
export function encodeNetlist(netlist: Netlist): Uint8Array {
  checkNetlist(netlist);
  const bytes = new Uint8Array(netlist.gates.length * NAND_BYTES);
  netlist.gates.forEach(([a, b], index) => {
    const at = index * NAND_BYTES;
    bytes[at] = NAND_OPCODE;
    bytes.set(u24(a), at + 1);
    bytes.set(u24(b), at + 4);
  });
  return bytes;
}

/** Decode NAND-only netlist bytes. Throws on any other opcode or a truncated gate. */
export function decodeNetlist(bytes: Uint8Array, nIn: number, nOut: number): Netlist {
  if (bytes.length % NAND_BYTES !== 0) throw new RangeError("netlist length is not a whole number of NAND gates");
  const gates: Gate[] = [];
  for (let at = 0; at < bytes.length; at += NAND_BYTES) {
    if (bytes[at] !== NAND_OPCODE) throw new RangeError(`opcode ${bytes[at]} at byte ${at} is not NAND`);
    gates.push([readU24(bytes, at + 1), readU24(bytes, at + 4)]);
  }
  const netlist = { nIn, nOut, gates };
  checkNetlist(netlist);
  return netlist;
}

function checkNetlist(netlist: Netlist): void {
  if (netlist.nOut < 1 || netlist.nOut > netlist.gates.length) throw new RangeError("outputs must be the last gates");
  netlist.gates.forEach(([a, b], index) => {
    const own = 2 + netlist.nIn + index;
    if (own > U24_MAX) throw new RangeError("too many signals for u24");
    for (const read of [a, b]) {
      if (!Number.isInteger(read) || read < 0 || read >= own) throw new RangeError(`gate ${index} reads future signal ${read}`);
    }
  });
}

function u24(value: number): number[] {
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function readU24(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!;
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function fromHex(hex: string): Uint8Array {
  const body = hex.trim().replace(/^0x/u, "");
  if (!/^(?:[0-9a-f]{2})*$/u.test(body)) throw new RangeError("not lower-case hex bytes");
  return new Uint8Array(Buffer.from(body, "hex"));
}

// ── Evaluators ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Evaluate one input vector the way `eval` does: signal by signal. Returns the output vector (pin k = bit k). */
export function evaluate(netlist: Netlist, vector: number): number {
  if (netlist.nIn > 32 || netlist.nOut > 32) throw new RangeError("evaluate takes at most 32 inputs and 32 outputs");
  const values = new Uint8Array(2 + netlist.nIn + netlist.gates.length);
  values[CONST1] = 1;
  for (let pin = 0; pin < netlist.nIn; pin++) values[2 + pin] = (vector >>> pin) & 1;
  netlist.gates.forEach(([a, b], index) => {
    values[2 + netlist.nIn + index] = values[a]! & values[b]! ? 0 : 1;
  });
  const first = values.length - netlist.nOut;
  let out = 0;
  for (let k = 0; k < netlist.nOut; k++) out |= values[first + k]! << k;
  return out >>> 0;
}

/** Input pins packed into each 32-bit word: pins 0-4 change inside a word, the rest are fixed per word. */
const LANE_PINS = 5;
const LANE_PATTERNS = [0xaaaaaaaa, 0xcccccccc, 0xf0f0f0f0, 0xff00ff00, 0xffff0000];

/**
 * Evaluate 32 input vectors at once: `base`, base+1, … base+31 (base a multiple of 32). Returns one 32-bit word per
 * output pin; bit j of word k is output pin k for vector base+j. `scratch` is reused between calls.
 */
export function evaluate32(netlist: Netlist, base: number, scratch: Int32Array): Int32Array {
  if (base % 32 !== 0) throw new RangeError("base must be a multiple of 32");
  if (netlist.nIn > 32) throw new RangeError("evaluate32 takes at most 32 inputs");
  const values = scratch;
  values[CONST0] = 0;
  values[CONST1] = -1;
  for (let pin = 0; pin < netlist.nIn; pin++) {
    values[2 + pin] = pin < LANE_PINS ? LANE_PATTERNS[pin]! | 0 : (base >>> pin) & 1 ? -1 : 0;
  }
  const gates = netlist.gates;
  let signal = 2 + netlist.nIn;
  for (let i = 0; i < gates.length; i++, signal++) {
    const gate = gates[i]!;
    values[signal] = ~(values[gate[0]]! & values[gate[1]]!);
  }
  return values.subarray(signal - netlist.nOut, signal);
}

export function scratchFor(netlist: Netlist): Int32Array {
  return new Int32Array(2 + netlist.nIn + netlist.gates.length);
}
