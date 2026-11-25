import { readFileSync } from "node:fs";
import type { CmcEnvelope, CryptoInfoData, RwaQuotesLatestData } from "../src/cmc.ts";
import type { LifiQuoteResponse } from "../src/lifi.ts";

const dir = new URL("./fixtures/", import.meta.url);
const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as T;

/** Recorded CMC responses (2026-11-25T17:09Z), trimmed to the fields we read. */
export const rwaQuotesNvda = () => load<CmcEnvelope<RwaQuotesLatestData>>("cmc-rwa-quotes-latest-nvda.json");
export const cryptoInfoNvda = () => load<CmcEnvelope<CryptoInfoData>>("cmc-crypto-info-nvda.json");
/** Recorded LI.FI quote: 100 USDC -> NVDAx on Ethereum (2026-11-25T17:06Z). */
export const lifiQuoteNvdax = () => load<LifiQuoteResponse>("lifi-quote-usdc-nvdax-ethereum.json");

export interface SeenRequest {
  url: URL;
  headers: Record<string, string>;
}

/** A fetch stand-in that answers by URL path and records what was asked. */
export function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: SeenRequest[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, seen };
}

/** prepare_swap answer from the production connector (handoff id replaced). */
export const prepareSwapNvdac = () => load<Record<string, unknown> & { trades: Record<string, unknown>[] }>("despell-prepare-swap-nvdac-base.json");

/** A fake MCP connector endpoint: answers tools/call with the given tool results, as SSE like the real one. */
export function fakeConnector(answer: (tool: string, args: Record<string, unknown>) => unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
    calls.push({ tool: req.params.name, args: req.params.arguments });
    const result = answer(req.params.name, req.params.arguments);
    const msg = { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
    return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
