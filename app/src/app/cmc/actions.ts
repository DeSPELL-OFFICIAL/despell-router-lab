"use server";

import { createDespellConnector, DespellConnectorError, prepareWrapperBuy, USDC } from "@despell-lab/cmc";
import { BUY_LINKS_PER_MINUTE, CMC_SPEND_USD } from "@/lib/cmc-env";
import { getWrapperScreen } from "@/lib/cmc-screen";
import { createRateLimit } from "@/lib/rate-limit";

/*
  [Buy this one] -> a DeSpell handoff link.

  This only asks DeSpell's public connector for a link; it signs nothing and
  moves nothing. Whoever opens the link sees a card in DeSpell, quoted for
  their own wallet, and nothing happens until they sign there.

  Server Functions can be called by a direct POST, so nothing from the form
  is trusted beyond picking a row:
    - the chain and address must be a row the current measured screen shows
      with an enabled Buy; a disabled or unknown row is refused here too;
    - the amount is not a field: it is the amount the list was ranked for;
    - at most BUY_LINKS_PER_MINUTE links per minute leave this process;
    - DeSpell's answer must match the request and point at DeSpell itself
      (prepareWrapperBuy).
*/

// A "use server" file may only export async functions, so the cap lives in cmc-env.
const takeBuySlot = createRateLimit(BUY_LINKS_PER_MINUTE, 60_000);

export type BuyLinkState =
  | { status: "idle" }
  | {
      status: "ready";
      url: string;
      expiresAt: string;
      payAmount: string;
      paySymbol: string;
      receiveSymbol: string;
      chainId: number;
      host: string;
    }
  | { status: "error"; message: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CANNOT_BUY: BuyLinkState = { status: "error", message: "This wrapper cannot be bought here." };

export async function prepareBuyLink(_prev: BuyLinkState, form: FormData): Promise<BuyLinkState> {
  const chainId = Number(form.get("chainId"));
  const tokenAddress = String(form.get("tokenAddress") ?? "");
  if (!Number.isInteger(chainId) || !USDC[chainId] || !ADDRESS_RE.test(tokenAddress)) return CANNOT_BUY;

  if (!takeBuySlot()) return { status: "error", message: "Many buy links were asked for just now. Try again in a minute." };

  const measured = await getWrapperScreen();
  if (measured.kind !== "screen") return { status: "error", message: "Buying is not available right now." };
  const row = measured.screen.rows.find((r) => r.chainId === chainId && r.address.toLowerCase() === tokenAddress.toLowerCase());
  if (!row || row.buy.kind !== "enabled") return CANNOT_BUY;

  try {
    const link = await prepareWrapperBuy(createDespellConnector({ url: measured.target.url }), {
      chainId: row.chainId,
      tokenAddress: row.address,
      amount: String(CMC_SPEND_USD),
    });
    return {
      status: "ready",
      url: link.url,
      expiresAt: link.expiresAt,
      payAmount: link.amount,
      paySymbol: link.pay.symbol,
      receiveSymbol: row.symbol,
      chainId: link.chainId,
      host: measured.target.host,
    };
  } catch (err) {
    const known = err instanceof DespellConnectorError;
    console.error("cmc buy link failed", known ? err.message : err);
    return {
      status: "error",
      message: known && /refused/.test(err.message) ? "DeSpell refused this trade. Try another wrapper." : "DeSpell did not answer. Try again in a moment.",
    };
  }
}
