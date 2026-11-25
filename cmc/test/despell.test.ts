import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBuyable, checkHandoffUrl, createDespellConnector, DespellConnectorError, prepareWrapperBuy } from "../src/despell.ts";
import { fakeConnector, prepareSwapNvdac } from "./helpers.ts";

const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const connectorWith = (answer: Parameters<typeof fakeConnector>[0]) => {
  const f = fakeConnector(answer);
  return { connector: createDespellConnector({ url: "https://app.despell.io/api/mcp", fetch: f.fetch }), calls: f.calls };
};

test("the connector reads tool results from server-sent events and plain JSON", async () => {
  const { connector, calls } = connectorWith(() => ({ ok: true, hello: 1 }));
  assert.deepEqual(await connector.callTool("find_token", { query: "x", chainId: 1 }), { ok: true, hello: 1 });
  assert.equal(calls[0]!.tool, "find_token");

  const json = createDespellConnector({
    url: "https://app.despell.io/api/mcp",
    fetch: (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"ok":true}' }] } }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  assert.deepEqual(await json.callTool("find_token", {}), { ok: true });
});

test("connector failures are DespellConnectorError", async () => {
  const http = createDespellConnector({ fetch: (async () => new Response("{}", { status: 429 })) as typeof fetch });
  await assert.rejects(http.callTool("find_token", {}), /HTTP 429/);
  const rpc = createDespellConnector({
    fetch: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "bad" } }))) as typeof fetch,
  });
  await assert.rejects(rpc.callTool("find_token", {}), /connector error: bad/);
  const down = createDespellConnector({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(down.callTool("find_token", {}), DespellConnectorError);
  assert.throws(() => createDespellConnector({ url: "http://example.com/api/mcp" }), /https/);
});

test("buyable only when find_token resolves this exact address on this chain", async () => {
  const resolved = connectorWith(() => ({ ok: true, status: "resolved", token: { chainId: 8453, address: NVDAC } }));
  assert.deepEqual(await checkBuyable(resolved.connector, 8453, NVDAC.toUpperCase().replace("0X", "0x")), { buyable: true });
  assert.deepEqual(resolved.calls[0]!.args, { query: NVDAC.toUpperCase().replace("0X", "0x"), chainId: 8453 });

  const other = connectorWith(() => ({ ok: true, status: "resolved", token: { chainId: 8453, address: BASE_USDC } }));
  assert.equal((await checkBuyable(other.connector, 8453, NVDAC)).buyable, false);

  const missing = connectorWith(() => ({ ok: true, status: "not_found", suggestions: [] }));
  assert.deepEqual(await checkBuyable(missing.connector, 42161, NVDAC), { buyable: false, reason: "not_on_despell", detail: "not_found" });

  const broken = createDespellConnector({ fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch });
  assert.equal(((await checkBuyable(broken, 8453, NVDAC)) as { reason: string }).reason, "check_failed");

  // No USDC on that chain: not even asked.
  const unasked = connectorWith(() => ({}));
  assert.equal(((await checkBuyable(unasked.connector, 424242, NVDAC)) as { reason: string }).reason, "no_pay_token");
  assert.equal(unasked.calls.length, 0);
});

test("prepare_swap is asked for exactly USDC -> wrapper on the row's chain, for the row's amount", async () => {
  const { connector, calls } = connectorWith(() => prepareSwapNvdac());
  const link = await prepareWrapperBuy(connector, { chainId: 8453, tokenAddress: NVDAC, amount: "100" });

  assert.deepEqual(calls[0], {
    tool: "prepare_swap",
    args: { trades: [{ fromChainId: 8453, fromToken: BASE_USDC, toToken: NVDAC, amount: "100" }] },
  });
  assert.equal(link.url, "https://app.despell.io/?handoff=AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(link.chainId, 8453);
  assert.equal(link.pay.address, BASE_USDC);
  assert.equal(link.receive.address, NVDAC);
  assert.equal(link.receive.symbol, "NVDAc");
  assert.equal(link.amount, "100");
});

test("an answer that differs from the request is refused", async () => {
  const tamper = (edit: (r: ReturnType<typeof prepareSwapNvdac>) => void) => {
    const r = prepareSwapNvdac();
    edit(r);
    return connectorWith(() => r).connector;
  };
  const ask = { chainId: 8453, tokenAddress: NVDAC, amount: "100" };
  const cases: [string, (r: ReturnType<typeof prepareSwapNvdac>) => void][] = [
    ["other token", (r) => ((r.trades[0]!.toToken as { address: string }).address = BASE_USDC)],
    ["other pay token", (r) => ((r.trades[0]!.fromToken as { address: string }).address = NVDAC)],
    ["other amount", (r) => (r.trades[0]!.amount = "1000")],
    ["other chain", (r) => (r.trades[0]!.toChainId = 1)],
    ["two trades", (r) => r.trades.push(r.trades[0]!)],
    ["executed", (r) => (r.executed = true)],
    ["refused", (r) => ((r.ok = false), (r.error = "token_unverified"))],
    ["foreign link", (r) => (r.url = "https://evil.example/?handoff=AAAAAAAAAAAAAAAAAAAAAA")],
    ["extra query", (r) => (r.url = "https://app.despell.io/?handoff=AAAAAAAAAAAAAAAAAAAAAA&to=0x1")],
    ["other path", (r) => (r.url = "https://app.despell.io/swap?handoff=AAAAAAAAAAAAAAAAAAAAAA")],
    ["no link", (r) => delete r.url],
  ];
  for (const [name, edit] of cases) {
    await assert.rejects(prepareWrapperBuy(tamper(edit), ask), DespellConnectorError, name);
  }
});

test("bad requests are refused before calling the connector", async () => {
  const { connector, calls } = connectorWith(() => prepareSwapNvdac());
  await assert.rejects(prepareWrapperBuy(connector, { chainId: 424242, tokenAddress: NVDAC, amount: "100" }), /no USDC/);
  await assert.rejects(prepareWrapperBuy(connector, { chainId: 8453, tokenAddress: "NVDAc", amount: "100" }), /0x address/);
  await assert.rejects(prepareWrapperBuy(connector, { chainId: 8453, tokenAddress: NVDAC, amount: "0" }), /positive/);
  await assert.rejects(prepareWrapperBuy(connector, { chainId: 8453, tokenAddress: NVDAC, amount: "1e3" }), /positive/);
  assert.equal(calls.length, 0);
});

test("handoff links must stay on the connector's own site", () => {
  const origin = "https://app.despell.io";
  assert.equal(checkHandoffUrl("https://app.despell.io/?handoff=abcdEFGH1234_-xyz", origin), "https://app.despell.io/?handoff=abcdEFGH1234_-xyz");
  assert.throws(() => checkHandoffUrl("https://app.despell.io.evil.example/?handoff=abcdEFGH1234_-xyz", origin));
  assert.throws(() => checkHandoffUrl("javascript:alert(1)", origin));
  assert.throws(() => checkHandoffUrl("https://app.despell.io/?handoff=short", origin));
  assert.throws(() => checkHandoffUrl("https://app.despell.io/?handoff=abcdEFGH1234_-xyz#x", origin));
});
