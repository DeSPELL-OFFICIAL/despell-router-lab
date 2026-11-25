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
});
