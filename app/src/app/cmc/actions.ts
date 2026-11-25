"use server";

import { createDespellConnector, DespellConnectorError, prepareWrapperBuy, USDC } from "@despell-lab/cmc";
import { CMC_SPEND_USD, despellConnectorTarget } from "@/lib/cmc-env";

/*
  [Buy this one] -> a DeSpell handoff link.

  This only asks DeSpell's public connector for a link; it signs nothing and
  moves nothing. Whoever opens the link sees a card in DeSpell, quoted for
  their own wallet, and nothing happens until they sign there.

  Server Functions can be called by a direct POST, so the form fields are
  checked again here: a chain we have USDC for, a 0x address. The amount is
  not a field: it is always the amount the list was ranked for. The answer is
  checked against the request in prepareWrapperBuy (chain, both tokens,
  amount, and that the link is the connector's own site).
*/

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

export async function prepareBuyLink(_prev: BuyLinkState, form: FormData): Promise<BuyLinkState> {
  const chainId = Number(form.get("chainId"));
  const tokenAddress = String(form.get("tokenAddress") ?? "");
  if (!Number.isInteger(chainId) || !USDC[chainId] || !ADDRESS_RE.test(tokenAddress)) {
    return { status: "error", message: "This wrapper cannot be bought here." };
  }

  const target = despellConnectorTarget();
  try {
    const link = await prepareWrapperBuy(createDespellConnector({ url: target.url }), {
      chainId,
      tokenAddress,
      amount: String(CMC_SPEND_USD),
    });
    return {
      status: "ready",
      url: link.url,
      expiresAt: link.expiresAt,
      payAmount: link.amount,
      paySymbol: link.pay.symbol,
      receiveSymbol: link.receive.symbol,
      chainId: link.chainId,
      host: target.host,
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
