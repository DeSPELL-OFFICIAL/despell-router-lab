import type { Metadata } from "next";
import { connection } from "next/server";
import { CmcError, createCmcClient, createDespellConnector, createLifiQuoter, loadWrapperScreen, type WrapperScreen } from "@despell-lab/cmc";
import { getContest } from "@/lib/contests";
import { CMC_SPEND_USD, CMC_SYMBOL, cmcApiKey, despellConnectorTarget, lifiApiKey } from "@/lib/cmc-env";
import { createMeasureCache } from "@/lib/measure-cache";
import { WrapperList } from "./wrapper-list";
import "./cmc.css";

export const metadata: Metadata = { title: "CoinMarketCap API" };

// One measurement is shared by page views: 5 minutes when complete, 1 minute
// when some quotes failed or DeSpell could not be asked about a row.
const cache = createMeasureCache<WrapperScreen>(
  (screen) => screen.incomplete === 0 && !screen.rows.some((r) => r.buy.kind === "disabled" && r.buy.reason === "check_failed"),
);

async function measure(apiKey: string, connectorUrl: string): Promise<{ screen: WrapperScreen } | { error: string }> {
  try {
    const lifiKey = lifiApiKey();
    const screen = await cache(() =>
      loadWrapperScreen({
        cmc: createCmcClient({ apiKey }),
        quoter: createLifiQuoter(lifiKey ? { apiKey: lifiKey } : {}),
        connector: createDespellConnector({ url: connectorUrl }),
        symbol: CMC_SYMBOL,
        spendUsd: CMC_SPEND_USD,
      }),
    );
    return { screen };
  } catch (err) {
    console.error("cmc compare failed", err instanceof Error ? err.message : err);
    // CmcError messages carry CMC's code and text, never the key.
    return { error: err instanceof CmcError ? err.message : "Could not compare the wrappers right now." };
  }
}

export default async function Page() {
  await connection(); // prices are measured per request, never at build time
  const c = getContest("cmc");
  const apiKey = cmcApiKey();
  const target = despellConnectorTarget();
  const measured = !apiKey ? null : target.ok ? await measure(apiKey, target.url) : { error: target.error };

  return (
    <main className="lab-main lab-narrow cmc-main">
      <p className="lab-eyebrow">{c.hackathon}</p>
      <h1 className="lab-h1">
        Same stock, many tokens. <em>Which one gives you the most for $100?</em>
      </h1>
      <p className="lab-lede">
        CoinMarketCap&apos;s RWA data lists every tokenized NVIDIA wrapper and its issuer. Each one is quoted for {CMC_SPEND_USD} USDC on its
        own chain, and ranked by the stock you actually end up holding after the price gap and the route&apos;s gas and fees. Buying opens
        the same trade as a DeSpell card, where you sign with your own wallet.
      </p>

      {!apiKey && (
        <div className="ds-sum is-plain" role="status">
          <div className="ds-sum-head">
            <span className="ds-sum-mark">i</span>
            <span className="ds-sum-title">
              Set <code>CMC_PRO_API_KEY</code> on the server to measure live prices.
            </span>
          </div>
        </div>
      )}
      {measured && "error" in measured && (
        <div className="ds-sum is-stop" role="alert">
          <div className="ds-sum-head">
            <span className="ds-sum-mark">!</span>
            <span className="ds-sum-title">{measured.error}</span>
          </div>
        </div>
      )}
      {measured && "screen" in measured && target.ok && (
        <WrapperList screen={measured.screen} connectorHost={target.host} production={target.production} />
      )}
    </main>
  );
}
