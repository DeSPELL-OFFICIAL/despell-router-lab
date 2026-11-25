import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareBuyLink } from "./actions";

const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

type Call = { url: string; trades: Record<string, unknown>[] };
let calls: Call[];

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** Stand-in for DeSpell's connector: echoes the trade it was asked for, like the real one. */
function connectorEcho(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: { arguments: { trades: Record<string, unknown>[] } } };
    const t = body.params.arguments.trades[0]!;
    calls.push({ url: String(input), trades: body.params.arguments.trades });
    const result = {
      ok: true,
      executed: false,
      url: "https://app.despell.io/?handoff=CCCCCCCCCCCCCCCCCCCCCC",
      expiresAt: "2026-11-25T18:30:00.000Z",
      trades: [
        {
          kind: "swap",
          fromChainId: t.fromChainId,
          toChainId: t.fromChainId,
          fromToken: { symbol: "USDC", address: t.fromToken },
          toToken: { symbol: "NVDAc", address: t.toToken },
          amount: t.amount,
        },
      ],
      ...overrides,
    };
    const msg = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
    return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("DESPELL_MCP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("prepareBuyLink", () => {
  it("asks the production connector for 100 USDC -> the row's token on the row's chain", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    const state = await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://app.despell.io/api/mcp");
    expect(calls[0]!.trades).toEqual([{ fromChainId: 8453, fromToken: BASE_USDC, toToken: NVDAC, amount: "100" }]);
    expect(state).toMatchObject({
      status: "ready",
      url: "https://app.despell.io/?handoff=CCCCCCCCCCCCCCCCCCCCCC",
      chainId: 8453,
      payAmount: "100",
      paySymbol: "USDC",
      receiveSymbol: "NVDAc",
      host: "app.despell.io",
    });
  });

  it("ignores any amount sent in the form: the spend is fixed on the server", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC, amount: "100000" }));
    expect(calls[0]!.trades[0]!.amount).toBe("100");
  });

  it("refuses unknown chains and non-addresses without calling DeSpell", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    for (const f of [
      form({ chainId: "424242", tokenAddress: NVDAC }),
      form({ chainId: "8453", tokenAddress: "NVDAc" }),
      form({ chainId: "8453.5", tokenAddress: NVDAC }),
      form({ tokenAddress: NVDAC }),
    ]) {
      expect((await prepareBuyLink({ status: "idle" }, f)).status).toBe("error");
    }
    expect(calls).toHaveLength(0);
  });

  it("does not hand out a link that points anywhere but DeSpell", async () => {
    vi.stubGlobal("fetch", connectorEcho({ url: "https://evil.example/?handoff=CCCCCCCCCCCCCCCCCCCCCC" }));
    const state = await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }));
    expect(state.status).toBe("error");
  });

  it("uses DESPELL_MCP_URL when set", async () => {
    vi.stubEnv("DESPELL_MCP_URL", "https://test.despell.io/api/mcp");
    vi.stubGlobal("fetch", connectorEcho({ url: "https://test.despell.io/?handoff=CCCCCCCCCCCCCCCCCCCCCC" }));
    const state = await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }));
    expect(calls[0]!.url).toBe("https://test.despell.io/api/mcp");
    expect(state).toMatchObject({ status: "ready", host: "test.despell.io" });
  });
});

describe("prepareBuyLink with a bad DESPELL_MCP_URL", () => {
  it("says buying is not set up, and never falls back to production", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    for (const bad of ["test.despell.io/api/mcp", "http://test.despell.io/api/mcp"]) {
      vi.stubEnv("DESPELL_MCP_URL", bad);
      const state = await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }));
      expect(state).toEqual({ status: "error", message: "Buying is not set up on this server." });
    }
    expect(calls).toHaveLength(0);
  });
});
