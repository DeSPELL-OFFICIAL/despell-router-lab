import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowView, WrapperScreen } from "@despell-lab/cmc";

const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const RNVDA = "0x0a85b6ebe3c150a1979a65656e304033d62b1e12";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const row = (symbol: string, chainId: number, address: string, buy: RowView["buy"]): RowView => ({
  key: `${chainId}:${address}`,
  symbol,
  issuer: "Issuer",
  chainName: "Chain",
  chainId,
  address,
  cmcPriceUsd: 144,
  volume24hUsd: 1,
  receivedUsd: 99.7,
  premiumPct: 0.1,
  shortfallUsd: 0.3,
  knownCostUsd: 0.25,
  priceGapUsd: 0.05,
  badges: [],
  bestBlocked: null,
  buy,
});

const SCREEN: WrapperScreen = {
  asset: { rwaId: 2, symbol: "NVDA", name: "Nvidia Corp" },
  spendUsd: 100,
  referencePriceUsd: 144,
  pricesAsOf: "2026-11-25T19:09:11.000Z",
  quotedAt: "2026-11-25T19:09:34.000Z",
  incomplete: 0,
  noBest: null,
  rows: [
    row("rNVDA", 42161, RNVDA, { kind: "disabled", reason: "not_on_despell" }),
    row("NVDAc", 8453, NVDAC, { kind: "enabled" }),
  ],
  folded: [],
};

const target = { ok: true as const, url: "https://app.despell.io/api/mcp", host: "app.despell.io", production: true };
const getWrapperScreen = vi.fn(async () => ({ kind: "screen" as const, screen: SCREEN, target, backingOffUntil: null }));
vi.mock("@/lib/cmc-screen", () => ({ getWrapperScreen: () => getWrapperScreen() }));

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
          toToken: { symbol: "SOMETHING-ELSE", address: t.toToken },
          amount: t.amount,
        },
      ],
      ...overrides,
    };
    const msg = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
    return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
}

// Fresh module per test so the per-minute counter starts at zero.
async function load() {
  vi.resetModules();
  return (await import("./actions")).prepareBuyLink;
}

beforeEach(() => {
  calls = [];
  getWrapperScreen.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepareBuyLink", () => {
  it("asks DeSpell for 100 USDC -> the row's token on the row's chain, and names it with the row's symbol", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    const prepareBuyLink = await load();
    const state = await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC.toUpperCase().replace("0X", "0x") }));

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
    const prepareBuyLink = await load();
    await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC, amount: "100000" }));
    expect(calls[0]!.trades[0]!.amount).toBe("100");
  });

  it("refuses a row whose Buy is disabled, and any token the screen does not show", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    const prepareBuyLink = await load();
    const refused = [
      form({ chainId: "42161", tokenAddress: RNVDA }), // shown, but not on DeSpell
      form({ chainId: "8453", tokenAddress: BASE_USDC }), // a verified token, but not a row
      form({ chainId: "1", tokenAddress: NVDAC }), // right address, wrong chain
    ];
    for (const f of refused) {
      expect(await prepareBuyLink({ status: "idle" }, f)).toEqual({ status: "error", message: "This wrapper cannot be bought here." });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses malformed input without measuring or calling DeSpell", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    const prepareBuyLink = await load();
    for (const f of [
      form({ chainId: "424242", tokenAddress: NVDAC }),
      form({ chainId: "8453", tokenAddress: "NVDAc" }),
      form({ chainId: "8453.5", tokenAddress: NVDAC }),
      form({ tokenAddress: NVDAC }),
    ]) {
      expect((await prepareBuyLink({ status: "idle" }, f)).status).toBe("error");
    }
    expect(getWrapperScreen).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("caps how many links one process asks for per minute", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    const prepareBuyLink = await load();
    const { BUY_LINKS_PER_MINUTE } = await import("@/lib/cmc-env");
    const results = [];
    for (let i = 0; i <= BUY_LINKS_PER_MINUTE; i++) results.push((await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }))).status);
    expect(results.filter((s) => s === "ready")).toHaveLength(BUY_LINKS_PER_MINUTE);
    expect(results.at(-1)).toBe("error");
    expect(calls).toHaveLength(BUY_LINKS_PER_MINUTE);
  });

  it("does not count refused requests against the cap", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    const prepareBuyLink = await load();
    const { BUY_LINKS_PER_MINUTE } = await import("@/lib/cmc-env");
    for (let i = 0; i < BUY_LINKS_PER_MINUTE * 2; i++) await prepareBuyLink({ status: "idle" }, form({ chainId: "42161", tokenAddress: RNVDA }));
    expect((await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }))).status).toBe("ready");
  });

  it("does not hand out a link that points anywhere but DeSpell", async () => {
    vi.stubGlobal("fetch", connectorEcho({ url: "https://evil.example/?handoff=CCCCCCCCCCCCCCCCCCCCCC" }));
    const prepareBuyLink = await load();
    expect((await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }))).status).toBe("error");
  });

  it("says buying is unavailable when there is no measured screen", async () => {
    vi.stubGlobal("fetch", connectorEcho());
    getWrapperScreen.mockImplementationOnce(async () => ({ kind: "setup", message: "DESPELL_MCP_URL is not a URL." }) as never);
    const prepareBuyLink = await load();
    expect(await prepareBuyLink({ status: "idle" }, form({ chainId: "8453", tokenAddress: NVDAC }))).toEqual({
      status: "error",
      message: "Buying is not available right now.",
    });
    expect(calls).toHaveLength(0);
  });
});
