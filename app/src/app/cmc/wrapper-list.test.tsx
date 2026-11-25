import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RowView, WrapperScreen } from "@despell-lab/cmc";
import { WrapperList } from "./wrapper-list";

const row = (symbol: string, chainId: number, extra: Partial<RowView> = {}): RowView => ({
  key: `${chainId}:${symbol}`,
  symbol,
  issuer: "Issuer",
  chainName: "Base",
  chainId,
  address: "0x0000000000000000000000000000000000000001",
  cmcPriceUsd: 144.5,
  volume24hUsd: 58_200_000,
  receivedUsd: 99.67,
  premiumPct: 0.08,
  shortfallUsd: 0.33,
  knownCostUsd: 0.25,
  priceGapUsd: 0.08,
  badges: [],
  bestBlocked: null,
  buy: { kind: "enabled" },
  ...extra,
});

const screen = (rows: RowView[], extra: Partial<WrapperScreen> = {}): WrapperScreen => ({
  asset: { rwaId: 2, symbol: "NVDA", name: "Nvidia Corp" },
  spendUsd: 100,
  referencePriceUsd: 143.89,
  pricesAsOf: "2026-11-25T17:35:11.326Z",
  quotedAt: "2026-11-25T17:35:24.202Z",
  incomplete: 0,
  noBest: null,
  rows,
  folded: [{ key: "x", symbol: "NVDAX", issuer: "Backed Assets", chainName: "Solana", reason: "non_evm_chain" }],
  ...extra,
});

const render = (s: WrapperScreen, production = true, backingOffUntil: string | null = null) =>
  renderToStaticMarkup(
    <WrapperList
      screen={s}
      connectorHost={production ? "app.despell.io" : "test.despell.io"}
      production={production}
      backingOffUntil={backingOffUntil}
    />,
  );

describe("WrapperList", () => {
  it("keeps 'receives the most' on the true best and disables its buy when DeSpell cannot buy it", () => {
    const html = render(
      screen([
        row("rNVDA", 42161, { badges: ["best"], buy: { kind: "disabled", reason: "not_on_despell" } }),
        row("NVDAc", 8453, { badges: ["best_buyable"] }),
      ]),
    );
    expect(html).toMatch(/data-badge="best".*Receives the most/);
    expect(html).toMatch(/data-badge="best-buyable".*Most you can buy on DeSpell/);
    expect(html).toContain("Not on DeSpell&#x27;s verified token list");
    expect(html).toMatch(/<button type="button" class="ds-btn is-secondary" disabled=""[^>]*>Buy rNVDA<\/button>/);
    expect(html).toMatch(/<button type="submit" class="ds-btn is-primary">Buy NVDAc<\/button>/);
  });

  it("shows the no-winner state without badges", () => {
    const html = render(screen([row("NVDAX", 196)], { noBest: "incomplete", incomplete: 3 }));
    expect(html).toContain('data-state="no-best"');
    expect(html).toContain("No winner this time.");
    expect(html).toContain("Measure again");
    expect(html).not.toContain("data-badge=");
  });

  it("while backing off, says when the next measurement is instead of offering to measure again", () => {
    const html = render(screen([row("NVDAX", 196)], { noBest: "incomplete", incomplete: 3 }), true, "2026-11-25T19:50:00.000Z");
    expect(html).toMatch(/Next measurement after (<!-- -->)?19:50:00 UTC/);
    expect(html).not.toContain("Measure again");
  });

  it("names the price source, times and where buy links open", () => {
    const html = render(screen([row("NVDAX", 196, { badges: ["best"] })]));
    expect(html).toContain("Prices CoinMarketCap RWA");
    expect(html).toContain("CMC average tokenized price");
    expect(html).toContain("17:35:11 UTC");
    expect(html).toContain("17:35:24 UTC");
    expect(html).toContain("app.despell.io (production: signing there buys the real token)");
    expect(render(screen([row("NVDAX", 196)]), false)).toContain("test.despell.io (not production: a test deployment)");
  });

  it("folds wrappers without a route, with the reason", () => {
    const html = render(screen([row("NVDAX", 196)]));
    expect(html).toMatch(/1 more wrapper without a route/);
    expect(html).toContain("not an EVM chain");
  });
});

describe("WrapperList rows", () => {
  it("opens the best row and keeps a blocked row above it folded", () => {
    const html = render(
      screen([
        row("Cheap", 1, { bestBlocked: "discount_over_1pct" }),
        row("Best", 8453, { badges: ["best"] }),
        row("Other", 56),
      ]),
    );
    const open = [...html.matchAll(/<details class="cmc-row"( open="")? data-row="([^"]+)"/g)].map((m) => [m[2], Boolean(m[1])]);
    expect(open).toEqual([
      ["1:Cheap", false],
      ["8453:Best", true],
      ["56:Other", false],
    ]);
  });
});
