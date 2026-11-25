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

export type ConnectorTarget = { ok: true; url: string; host: string; production: boolean } | { ok: false; error: string };

/**
 * A malformed DESPELL_MCP_URL is reported, never replaced by the default:
 * silently falling back to production would turn a test setup into real buys.
 */
export function despellConnectorTarget(): ConnectorTarget {
  const raw = process.env.DESPELL_MCP_URL?.trim() || DEFAULT_DESPELL_MCP_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "DESPELL_MCP_URL is not a URL." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "DESPELL_MCP_URL must be an https URL." };
  return { ok: true, url: u.toString(), host: u.host, production: u.host === new URL(DEFAULT_DESPELL_MCP_URL).host };
}
