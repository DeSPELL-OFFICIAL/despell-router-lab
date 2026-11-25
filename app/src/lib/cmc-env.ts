import { DEFAULT_DESPELL_MCP_URL } from "@despell-lab/cmc";

/*
  Server-only settings for the /cmc demo: import this from Server Components
  and Server Functions only, never from a "use client" file. Values come from the environment
  (Vercel or an untracked env file); none are in the repository.

    CMC_PRO_API_KEY  CoinMarketCap Pro API key. Without it the page says so.
    LIFI_API_KEY     Optional LI.FI key: the keyless quote limit is tens an hour.
    DESPELL_MCP_URL  DeSpell's connector. Defaults to the production app,
                     so a link opened and signed there buys the real token.
*/

/** Every wrapper is compared for this much USDC, and every buy link spends this much. */
export const CMC_SPEND_USD = 100;
export const CMC_SYMBOL = "NVDA";

export function cmcApiKey(): string | null {
  return process.env.CMC_PRO_API_KEY?.trim() || null;
}

export function lifiApiKey(): string | null {
  return process.env.LIFI_API_KEY?.trim() || null;
}

export type ConnectorTarget = { url: string; host: string; production: boolean };

export function despellConnectorTarget(): ConnectorTarget {
  const url = process.env.DESPELL_MCP_URL?.trim() || DEFAULT_DESPELL_MCP_URL;
  const host = new URL(url).host;
  return { url, host, production: host === new URL(DEFAULT_DESPELL_MCP_URL).host };
}
