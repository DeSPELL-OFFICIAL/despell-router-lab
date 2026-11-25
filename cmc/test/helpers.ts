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
