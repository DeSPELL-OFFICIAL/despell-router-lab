import { createCmcClient, createDespellConnector, createLifiQuoter, loadWrapperScreen, type WrapperScreen } from "@despell-lab/cmc";
import { CMC_SPEND_USD, CMC_SYMBOL, cmcApiKey, despellConnectorTarget, lifiApiKey, type ConnectorTarget } from "./cmc-env";
import { createMeasureCache, type MeasureKind } from "./measure-cache";

/*
  The one measured wrapper screen this server shows, shared by the /cmc page
  and its Buy action (server only). The Buy action only accepts a row that
  this screen shows as buyable, so a direct POST cannot ask for a link to
  anything else.
*/

export type ScreenResult =
  | { kind: "screen"; screen: WrapperScreen; target: Extract<ConnectorTarget, { ok: true }> }
  | { kind: "setup"; message: string }
  | { kind: "error" };

function classify(screen: WrapperScreen): MeasureKind {
  if (screen.incomplete > 0) return "back_off";
  if (screen.rows.some((r) => r.buy.kind === "disabled" && r.buy.reason === "check_failed")) return "retry_soon";
  return "complete";
}

const cache = createMeasureCache<WrapperScreen>(classify);

export async function getWrapperScreen(): Promise<ScreenResult> {
  const apiKey = cmcApiKey();
  if (!apiKey) return { kind: "setup", message: "Set CMC_PRO_API_KEY on the server to measure live prices." };
  const target = despellConnectorTarget();
  if (!target.ok) return { kind: "setup", message: target.error };
  try {
    const lifiKey = lifiApiKey();
    const screen = await cache(() =>
      loadWrapperScreen({
        cmc: createCmcClient({ apiKey }),
        quoter: createLifiQuoter(lifiKey ? { apiKey: lifiKey } : {}),
        connector: createDespellConnector({ url: target.url }),
        symbol: CMC_SYMBOL,
        spendUsd: CMC_SPEND_USD,
      }),
    );
    return { kind: "screen", screen, target };
  } catch (err) {
    // The detail (CMC's code and message, never the key) stays in the server log.
    console.error("cmc compare failed", err instanceof Error ? err.message : err);
    return { kind: "error" };
  }
}
