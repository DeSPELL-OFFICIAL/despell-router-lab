import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignCard } from "./sign-card";
import { EMPTY_SWAP, EXAMPLE_SWAP } from "./examples";

const rows = (html: string) => [...html.matchAll(/data-row="([a-z]+)"/g)].map((m) => m[1]);

describe("SignCard", () => {
  it("keeps the design order: sends, receives, route, cost, check, actions", () => {
    expect(rows(renderToStaticMarkup(<SignCard {...EXAMPLE_SWAP} />))).toEqual(["sends", "receives", "route", "cost", "check", "actions"]);
  });

  it("shows every slot on an empty card, with the sign button disabled", () => {
    const html = renderToStaticMarkup(<SignCard {...EMPTY_SWAP} />);
    expect(rows(html)).toEqual(["sends", "receives", "route", "cost", "check", "actions"]);
    expect(html).toMatch(/<button type="button" class="ds-btn is-lg is-primary" disabled="">Sign<\/button>/);
  });

  it("puts contest rows after cost and lets the page own the decision row", () => {
    const html = renderToStaticMarkup(
      <SignCard
        {...EXAMPLE_SWAP}
        extraRows={<div data-row="circuit">Circuit #7 open</div>}
        action={<div data-row="wallet">connect</div>}
      />,
    );
    expect(rows(html)).toEqual(["sends", "receives", "route", "cost", "circuit", "check", "wallet"]);
  });

  it("uses a plain box, not a disclosure, when the check has no details", () => {
    const empty = renderToStaticMarkup(<SignCard {...EMPTY_SWAP} />);
    expect(empty).not.toContain('<details class="ds-sum');
    expect(empty).toContain('<div class="ds-sum is-plain" data-row="check">');
    expect(renderToStaticMarkup(<SignCard {...EXAMPLE_SWAP} />)).toContain('<details class="ds-sum is-ok" data-row="check">');
  });

  it("treats a null route label as empty", () => {
    const html = renderToStaticMarkup(<SignCard {...EMPTY_SWAP} route={{ label: null }} />);
    expect(html).toMatch(/data-row="route"><span class="ds-flow-k">Route<\/span><span class="ds-flow-v is-empty">/);
  });

  it("renders repeated labels without dropping rows", () => {
    const html = renderToStaticMarkup(
      <SignCard
        {...EXAMPLE_SWAP}
        cost={{ total: "$0.02", items: [{ label: "Gas", value: "$0.01" }, { label: "Gas", value: "$0.01" }] }}
        check={{ tone: "ok", title: "ok", detail: [["Chain", "Base Sepolia"], ["Chain", "GIWA Sepolia"]] }}
      />,
    );
    expect(html.match(/<span>Gas<\/span>/g)).toHaveLength(2);
    expect(html).toContain("Base Sepolia");
    expect(html).toContain("GIWA Sepolia");
  });
});
