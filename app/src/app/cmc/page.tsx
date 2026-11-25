import type { Metadata } from "next";
import { connection } from "next/server";
import { getContest } from "@/lib/contests";
import { CMC_SPEND_USD } from "@/lib/cmc-env";
import { getWrapperScreen } from "@/lib/cmc-screen";
import { WrapperList } from "./wrapper-list";
import "./cmc.css";

export const metadata: Metadata = { title: "CoinMarketCap API" };

export default async function Page() {
  await connection(); // prices are measured per request (through a shared cache), never at build time
  const c = getContest("cmc");
  const measured = await getWrapperScreen();

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

      {measured.kind === "setup" && (
        <div className="ds-sum is-plain" role="status">
          <div className="ds-sum-head">
            <span className="ds-sum-mark">i</span>
            <span className="ds-sum-title">{measured.message}</span>
          </div>
        </div>
      )}
      {measured.kind === "error" && (
        <div className="ds-sum is-stop" role="alert">
          <div className="ds-sum-head">
            <span className="ds-sum-mark">!</span>
            <span className="ds-sum-title">Could not compare the wrappers right now. Try again in a few minutes.</span>
          </div>
        </div>
      )}
      {measured.kind === "screen" && (
        <WrapperList screen={measured.screen} connectorHost={measured.target.host} production={measured.target.production} />
      )}
    </main>
  );
}
