import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, hexToBytes, toFunctionSelector, type Hex, type PublicClient } from "viem";
import { xLayer } from "viem/chains";
import { describe, expect, it } from "vitest";
import { packPins, OUTPUT_COUNT, unpackPins } from "@despell-lab/xlayer/src/bits.ts";
import { judge } from "@despell-lab/xlayer/src/rule.ts";
import { SELECTOR } from "@despell-lab/xlayer/src/onchain.ts";
import { GIWA_SEPOLIA, BASE_SEPOLIA } from "@/lib/swap/chains";
import { canSign } from "@/components/sign-card/sign-card";
import { CIRCUIT, evaluateLocally, parseDeployment, type CircuitDeployment } from "./circuit";
import { checkFrom, circuitGate, circuitLine, MALFORMED_TITLE, MISMATCH_TITLE, sameJudgment, type CircuitCheck } from "./check";
import { serverJudgmentFor } from "./server-judgment";
import { EVAL_ABI, judgeOnXLayer, NotAJudgmentError } from "./xlayer-eval";

const DEPLOYMENT: CircuitDeployment = { processor: "0x1111111111111111111111111111111111111111", circuitId: 7n };
const server = serverJudgmentFor(GIWA_SEPOLIA.id, GIWA_SEPOLIA.pool.address)!;

describe("the circuit gate on the card", () => {
  it("is pending while the circuit is being asked, so the sign button stays off", () => {
    const gate = circuitGate({ kind: "checking", server, deployment: DEPLOYMENT });
    expect(gate.state).toBe("pending");
  });

  it("holds the card when the circuit's judgment differs from the server's", () => {
    const check: CircuitCheck = { kind: "differs", server, deployment: DEPLOYMENT, circuit: { stage: "probation", lane: "standard" }, block: 1n };
    const gate = circuitGate(check);
    expect(gate).toMatchObject({ state: "hold", title: MISMATCH_TITLE });
    expect(gate.state === "hold" && gate.items).toContain("circuit: probation, standard lane");
    expect(circuitLine(check)).toEqual({ circuit: "Pool judgment circuit #7", status: "differs", tone: "stop" });
  });

  it("is open when the judgments are the same", () => {
    const check: CircuitCheck = { kind: "same", server, deployment: DEPLOYMENT, circuit: server.judgment, block: 1n };
    expect(circuitGate(check)).toEqual({ state: "ok" });
    expect(circuitLine(check)).toEqual({ circuit: "Pool judgment circuit #7", status: "same judgment", tone: "ok" });
  });

  // Defaults to be confirmed: nothing to compare does not hold the card.
  it("does not hold the card when there is no circuit yet, or X Layer cannot be reached", () => {
    expect(circuitGate({ kind: "not-deployed", server })).toEqual({ state: "ok" });
    expect(circuitLine({ kind: "not-deployed", server })?.status).toBe("being prepared");
    expect(circuitGate({ kind: "unreachable", server, deployment: DEPLOYMENT, reason: "HTTP 429" })).toEqual({ state: "ok" });
    expect(circuitLine({ kind: "unreachable", server, deployment: DEPLOYMENT, reason: "HTTP 429" })?.status).toBe("not reached");
  });

  it("adds no line for a pool the server has not judged", () => {
    expect(serverJudgmentFor(BASE_SEPOLIA.id, BASE_SEPOLIA.pool.key.hooks)).toBeNull();
    expect(circuitLine({ kind: "none" })).toBeNull();
    expect(circuitGate({ kind: "none" })).toEqual({ state: "ok" });
  });
});

describe("checkFrom (the hook's wiring)", () => {
  it("is checking while X Layer is being asked, including a re-judge, and the gate is pending", () => {
    const check = checkFrom(server, DEPLOYMENT, { status: "asking" });
    expect(check.kind).toBe("checking");
    expect(circuitGate(check).state).toBe("pending");
  });

  it("compares the answer with the server's judgment", () => {
    expect(checkFrom(server, DEPLOYMENT, { status: "answered", judgment: server.judgment, block: 5n }).kind).toBe("same");
    const differs = checkFrom(server, DEPLOYMENT, { status: "answered", judgment: { stage: "blocked", lane: "closed" }, block: 5n });
    expect(differs.kind).toBe("differs");
    expect(circuitGate(differs).state).toBe("hold");
  });

  it("is unreachable after a failed read, not held (default to be confirmed)", () => {
    const check = checkFrom(server, DEPLOYMENT, { status: "failed", reason: "HTTP 429" });
    expect(check).toMatchObject({ kind: "unreachable", reason: "HTTP 429" });
    expect(circuitGate(check).state).toBe("ok");
  });

  // A circuit id pointing at another circuit answers with bits that are not a judgment: that is the chain
  // disagreeing, not the network failing, so the card holds.
  it("holds the card when X Layer answers with something that is not a judgment", () => {
    const check = checkFrom(server, DEPLOYMENT, { status: "malformed", reason: "the circuit answered 0x6, which is not a judgment" });
    expect(check.kind).toBe("malformed");
    expect(circuitGate(check)).toMatchObject({ state: "hold", title: MALFORMED_TITLE });
    expect(circuitLine(check)?.status).toBe("not a judgment");
  });

  it("never asks without a server judgment or a deployment", () => {
    expect(checkFrom(null, DEPLOYMENT, { status: "asking" }).kind).toBe("none");
    expect(checkFrom(server, null, { status: "asking" }).kind).toBe("not-deployed");
  });
});

describe("the server judgment", () => {
  it("is the rule's answer for its own inputs (the recorded sample is consistent)", () => {
    expect(judge(server.input)).toEqual(server.judgment);
    expect(server.source).toBe("sample");
  });

  it("can be altered for the mismatch demo, which only ever differs from the circuit", () => {
    const altered = serverJudgmentFor(GIWA_SEPOLIA.id, GIWA_SEPOLIA.pool.address, { demoMismatch: true })!;
    expect(altered.demo).toBe("mismatch");
    expect(sameJudgment(altered.judgment, evaluateLocally(altered.input).judgment)).toBe(false);
  });
});

describe("the committed netlist", () => {
  it("is the 157-NAND pool judgment circuit and evaluates to the rule's judgment", () => {
    expect(CIRCUIT.nand).toBe(157);
    expect(CIRCUIT.nIn).toBe(27);
    expect(evaluateLocally(server.input).judgment).toEqual(judge(server.input));
  });
});

describe("parseDeployment", () => {
  it("needs a valid processor address and a positive circuit id", () => {
    expect(parseDeployment(undefined, undefined)).toBeNull();
    expect(parseDeployment("0x1111111111111111111111111111111111111111", "0")).toBeNull();
    expect(parseDeployment("0x1234", "7")).toBeNull();
    expect(parseDeployment("0x1111111111111111111111111111111111111111", " 7 ")).toEqual(DEPLOYMENT);
  });
});

describe("judgeOnXLayer", () => {
  it("calls TapeOut's eval(uint256,bytes), the selector xlayer/src/onchain.ts uses", () => {
    expect(toFunctionSelector(EVAL_ABI[0])).toBe(`0x${SELECTOR.eval}`);
  });

  it("throws NotAJudgmentError when the answer's stage code is 5–7", async () => {
    const transport = custom({
      async request({ method }: { method: string }) {
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_chainId") return "0xc4";
        if (method === "eth_call") return encodeFunctionResult({ abi: EVAL_ABI, functionName: "eval", result: "0x06" });
        throw new Error(`unexpected ${method}`);
      },
    });
    const client = createPublicClient({ chain: xLayer, transport }) as PublicClient;
    await expect(judgeOnXLayer(client, DEPLOYMENT, server.input)).rejects.toBeInstanceOf(NotAJudgmentError);
  });

  it("packs the input bits, reads the output bits back, and decodes the judgment", async () => {
    const seen: { id?: bigint; inputs?: Hex } = {};
    // A fake X Layer node that evaluates the committed netlist for the packed inputs it is sent.
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_chainId") return "0xc4";
        if (method === "eth_call") {
          const [call] = params as [{ data: Hex }];
          const { args } = decodeFunctionData({ abi: EVAL_ABI, data: call.data });
          seen.id = args[0];
          seen.inputs = args[1];
          const vector = unpackPins(hexToBytes(args[1]), 27);
          expect(vector).toBe(evaluateLocally(server.input).vector);
          const outputs = evaluateLocally(server.input).outputs;
          return encodeFunctionResult({ abi: EVAL_ABI, functionName: "eval", result: `0x${Buffer.from(packPins(outputs, OUTPUT_COUNT)).toString("hex")}` });
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const client = createPublicClient({ chain: xLayer, transport }) as PublicClient;
    const answer = await judgeOnXLayer(client, DEPLOYMENT, server.input);
    expect(seen.id).toBe(7n);
    expect(answer.judgment).toEqual(server.judgment);
    expect(answer.block).toBe(16n);
  });
});

describe("the card with the circuit gate", () => {
  it("cannot be signed while the circuit differs, whatever else passed", () => {
    const gate = circuitGate({ kind: "differs", server, deployment: DEPLOYMENT, circuit: { stage: "blocked", lane: "closed" }, block: 1n });
    // A card whose check box was turned to stop by the gate (view.ts puts a hold first).
    expect(gate.state).toBe("hold");
    const props = {
      sends: { amount: "−10", token: "USDC" },
      receives: { amount: "+0.003", token: "ETH" },
      check: { tone: "stop" as const, title: MISMATCH_TITLE },
      sign: { simulation: "passed" as const, onSign: () => {} },
    };
    expect(canSign(props)).toBe(false);
  });
});
