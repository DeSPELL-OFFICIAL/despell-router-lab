// Everything the wrapper screen needs, in one call: compare the wrappers,
// ask DeSpell which ranked ones it can buy, and build the screen model.

import { compareWrappers, type CompareOptions } from "./compare.ts";
import { checkBuyable, type Buyability, type DespellConnector } from "./despell.ts";
import { buildWrapperScreen, rowKey, type WrapperScreen } from "./view.ts";

export interface LoadScreenOptions extends CompareOptions {
  connector: DespellConnector;
}

export async function loadWrapperScreen(opts: LoadScreenOptions): Promise<WrapperScreen> {
  const { connector, ...compare } = opts;
  const result = await compareWrappers(compare);

  // Only ranked rows can carry a [Buy] button, so only they are checked.
  const ranked = result.rows.filter((r) => r.receivedValueUsd != null && r.wrapper.chainId != null && r.wrapper.address != null);
  const checks = await Promise.all(
    ranked.map(async (r): Promise<[string, Buyability]> => {
      const w = r.wrapper;
      return [rowKey(w.chainId, w.address, w.symbol), await checkBuyable(connector, w.chainId!, w.address!)];
    }),
  );
  return buildWrapperScreen(result, new Map(checks));
}
