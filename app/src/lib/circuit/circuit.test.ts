import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, hexToBytes, toFunctionSelector, type Hex, type PublicClient } from "viem";
import { CIRCUIT_ABI, CircuitRefusedError, verifyCircuit } from "./xlayer-eval";
import { xLayer } from "viem/chains";
import { describe, expect, it } from "vitest";
import { packPins, OUTPUT_COUNT, unpackPins } from "@despell-lab/xlayer/src/bits.ts";
import { judge } from "@despell-lab/xlayer/src/rule.ts";
import { SELECTOR } from "@despell-lab/xlayer/src/onchain.ts";
import { GIWA_SEPOLIA, BASE_SEPOLIA } from "@/lib/swap/chains";
import { canSign } from "@/components/sign-card/sign-card";
import { CIRCUIT, deploymentFrom, evaluateLocally, parseDeployment, TAPED_OUT, type CircuitDeployment } from "./circuit";
import { checkFrom, checkFromQuery, circuitGate, circuitLine, MISMATCH_TITLE, REFUSED_TITLE, sameJudgment, serverMark, type CircuitCheck, type QueryState } from "./check";
import { serverJudgmentFor } from "./server-judgment";
import { EVAL_ABI, judgeOnXLayer } from "./xlayer-eval";

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
    expect(serverJudgmentFor(BASE_SEPOLIA.id, BASE_SEPOLIA.pools[0].key.hooks)).toBeNull();
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

  // The chain answering "no" (not there, another circuit, not a judgment) is not the network failing: the card holds.
  it("holds the card when X Layer says the circuit is not there or not this one", () => {
    for (const [problem, status] of [["not-found", "not found"], ["wrong-circuit", "wrong circuit"], ["not-a-judgment", "not a judgment"]] as const) {
      const check = checkFrom(server, DEPLOYMENT, { status: "refused", problem, reason: "…" });
      expect(circuitGate(check)).toMatchObject({ state: "hold", title: REFUSED_TITLE[problem] });
      expect(circuitLine(check)?.status).toBe(status);
    }
  });

});

describe("checkFromQuery: a re-judge that fails in transport", () => {
  const q = (over: Partial<QueryState>): QueryState => ({ rejudging: false, data: undefined, dataUpdatedAt: 0, failure: null, failureUpdatedAt: 0, ...over });
  const same = { kind: "answered" as const, judgment: server.judgment, block: 5n };
  const differs = { kind: "answered" as const, judgment: { stage: "blocked" as const, lane: "closed" as const }, block: 5n };
  const refused = { kind: "refused" as const, problem: "not-found" as const, reason: "eval reverted" };

  it("keeps a hold: after 'differs' or 'refused' the card stays held, marked re-judge failed", () => {
    for (const earlier of [differs, refused]) {
      const r = checkFromQuery(server, DEPLOYMENT, q({ data: earlier, dataUpdatedAt: 100, failure: "HTTP 429", failureUpdatedAt: 200 }));
      expect(circuitGate(r.check).state).toBe("hold");
      expect(r.rejudgeFailed).toBe(true);
    }
  });

  it("does not show the old 'same judgment' after a failed re-judge: nothing is compared", () => {
    const r = checkFromQuery(server, DEPLOYMENT, q({ data: same, dataUpdatedAt: 100, failure: "HTTP 429", failureUpdatedAt: 200 }));
    expect(r.check.kind).toBe("unreachable");
    expect(r.rejudgeFailed).toBe(true);
  });

  it("takes a newer answer over an older failure, and is checking while re-judging", () => {
    expect(checkFromQuery(server, DEPLOYMENT, q({ data: same, dataUpdatedAt: 300, failure: "HTTP 429", failureUpdatedAt: 200 })).check.kind).toBe("same");
    expect(checkFromQuery(server, DEPLOYMENT, q({ rejudging: true, data: differs, dataUpdatedAt: 300 })).check.kind).toBe("checking");
    expect(checkFromQuery(server, DEPLOYMENT, q({ failure: "timeout", failureUpdatedAt: 1 }))).toEqual({
      check: { kind: "unreachable", server, deployment: DEPLOYMENT, reason: "timeout" },
      rejudgeFailed: false,
    });
  });

  it("never asks without a server judgment or a deployment", () => {
    expect(checkFrom(null, DEPLOYMENT, { status: "asking" }).kind).toBe("none");
    expect(checkFrom(server, null, { status: "asking" }).kind).toBe("not-deployed");
  });
});

describe("verifyCircuit", () => {
  /** A fake processor: answers circuitInfo and netlist, or fails the way it is told to. */
  type Fail =
    | "revert"
    | "empty"
    | "rate-limit"
    | "internal-reverted-text"
    | "internal-limit-text"
    | "internal-text-as-data"
    | "internal-with-revert-data";
  function node(answer: { info?: readonly [bigint, bigint, bigint, bigint]; netlist?: Hex; fail?: Fail }) {
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") return "0xc4";
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        if (answer.fail === "revert") throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        if (answer.fail === "empty") return "0x";
        if (answer.fail === "rate-limit") throw Object.assign(new Error("rate limited"), { code: -32005 });
        // -32603 is an internal error: viem reports it as a revert when it carries a message, but only revert data
        // (or code 3) is the chain answering.
        if (answer.fail === "internal-reverted-text") throw Object.assign(new Error("execution reverted"), { code: -32603 });
        if (answer.fail === "internal-limit-text") throw Object.assign(new Error("request limit reached, try again"), { code: -32603 });
        // Some nodes put text where revert data goes; viem passes it through as `raw`. Text is not revert data.
        if (answer.fail === "internal-text-as-data") throw Object.assign(new Error("execution reverted"), { code: -32603, data: "execution reverted" });
        if (answer.fail === "internal-with-revert-data") throw Object.assign(new Error("execution reverted"), { code: -32603, data: "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a6e6f2063697263756974000000000000000000000000000000000000000000" });
        const [call] = params as [{ data: Hex }];
        const { functionName } = decodeFunctionData({ abi: CIRCUIT_ABI, data: call.data });
        if (functionName === "circuitInfo") return encodeFunctionResult({ abi: CIRCUIT_ABI, functionName, result: answer.info ?? [27n, 5n, 0n, 157n] });
        if (functionName === "netlist") return encodeFunctionResult({ abi: CIRCUIT_ABI, functionName, result: answer.netlist ?? CIRCUIT.netlistHex });
        throw new Error(`unexpected ${functionName}`);
      },
    });
    return createPublicClient({ chain: xLayer, transport }) as PublicClient;
  }

  it("passes the circuit taped out from the committed netlist", async () => {
    await expect(verifyCircuit(node({}), DEPLOYMENT)).resolves.toBeUndefined();
  });

  it("refuses another circuit: different pins or gates, or a different netlist", async () => {
    await expect(verifyCircuit(node({ info: [14n, 5n, 0n, 46n] }), DEPLOYMENT)).rejects.toMatchObject({ problem: "wrong-circuit" });
    const other = `${CIRCUIT.netlistHex.slice(0, -2)}${CIRCUIT.netlistHex.endsWith("ff") ? "00" : "ff"}` as Hex;
    await expect(verifyCircuit(node({ netlist: other }), DEPLOYMENT)).rejects.toMatchObject({ problem: "wrong-circuit" });
  });

  it("calls code 3, revert data or an empty answer 'not found'", async () => {
    for (const fail of ["revert", "empty", "internal-with-revert-data"] as const) {
      await expect(verifyCircuit(node({ fail }), DEPLOYMENT), fail).rejects.toMatchObject({ problem: "not-found" });
    }
  });

  it("leaves a rate limit or an internal error (-32603) without hex revert data as a network failure", async () => {
    for (const fail of ["rate-limit", "internal-reverted-text", "internal-limit-text", "internal-text-as-data"] as const) {
      const error = await verifyCircuit(node({ fail }), DEPLOYMENT).catch((e: unknown) => e);
      expect(error, fail).not.toBeInstanceOf(CircuitRefusedError);
    }
  });

  it("uses the selectors xlayer/src/onchain.ts uses", () => {
    expect(toFunctionSelector(CIRCUIT_ABI[1])).toBe(`0x${SELECTOR.netlist}`);
    expect(toFunctionSelector(CIRCUIT_ABI[2])).toBe(`0x${SELECTOR.circuitInfo}`);
  });
});

describe("the card's own mark of the server judgment", () => {
  it("says the sample and the demo on the card", () => {
    expect(serverMark(server)).toBe("server: recorded sample");
    expect(serverMark(serverJudgmentFor(GIWA_SEPOLIA.id, GIWA_SEPOLIA.pool.address, { demoMismatch: true })!)).toBe("server judgment altered (demo)");
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

describe("deploymentFrom", () => {
  it("is the X Layer mainnet tape-out unless both settings override it", () => {
    expect(TAPED_OUT).toEqual({ processor: "0x3A49E01c0080FF9F99B5Df164e7ac27941836603", circuitId: 1n });
    expect(deploymentFrom(undefined, undefined)).toEqual(TAPED_OUT);
    expect(deploymentFrom("0x1111111111111111111111111111111111111111", "7")).toEqual(DEPLOYMENT);
  });

  it("keeps the tape-out when a setting is missing or mistyped, so the check is never turned off", () => {
    expect(deploymentFrom("0x1111111111111111111111111111111111111111", undefined)).toEqual(TAPED_OUT);
    expect(deploymentFrom("", "")).toEqual(TAPED_OUT);
    expect(deploymentFrom("0x1234", "7")).toEqual(TAPED_OUT);
  });
});

describe("judgeOnXLayer", () => {
  it("calls TapeOut's eval(uint256,bytes), the selector xlayer/src/onchain.ts uses", () => {
    expect(toFunctionSelector(EVAL_ABI[0])).toBe(`0x${SELECTOR.eval}`);
  });

  it("refuses an answer whose stage code is 5–7 as not a judgment", async () => {
    const transport = custom({
      async request({ method }: { method: string }) {
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_chainId") return "0xc4";
        if (method === "eth_call") return encodeFunctionResult({ abi: EVAL_ABI, functionName: "eval", result: "0x06" });
        throw new Error(`unexpected ${method}`);
      },
    });
    const client = createPublicClient({ chain: xLayer, transport }) as PublicClient;
    await expect(judgeOnXLayer(client, DEPLOYMENT, server.input)).rejects.toMatchObject({ problem: "not-a-judgment" });
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
