import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canSign, SignCard, type SignCardProps } from "./sign-card";
import { EMPTY_SWAP, EXAMPLE_SWAP } from "./examples";

const rows = (html: string) => [...html.matchAll(/data-row="([a-z]+)"/g)].map((m) => m[1]);
const signButton = (html: string) => html.match(/<button[^>]*data-action="sign"[^>]*>/)?.[0] ?? "";
const noop = () => {};

const READY: SignCardProps = { ...EXAMPLE_SWAP, sign: { simulation: "passed", onSign: noop } };

describe("SignCard", () => {
  it("keeps the design order: sends, receives, route, cost, check, actions", () => {
    expect(rows(renderToStaticMarkup(<SignCard {...EXAMPLE_SWAP} />))).toEqual(["sends", "receives", "route", "cost", "check", "actions"]);
  });

  it("shows every slot on an empty card, with the sign button disabled", () => {
    const html = renderToStaticMarkup(<SignCard {...EMPTY_SWAP} />);
    expect(rows(html)).toEqual(["sends", "receives", "route", "cost", "check", "actions"]);
    expect(signButton(html)).toContain('disabled=""');
  });

  it("puts contest rows after cost; the decision row stays the card's own", () => {
    const html = renderToStaticMarkup(<SignCard {...READY} extraRows={<div data-row="circuit">Circuit #7 open</div>} />);
    expect(rows(html)).toEqual(["sends", "receives", "route", "cost", "circuit", "check", "actions"]);
  });

  it("cannot be handed a sign button by the page", () => {
    // `action` was the old free-form decision slot. It is gone from the type, and anything passed under that
    // name is ignored, so a page cannot draw an enabled button that skips the gate.
    const props = { ...EMPTY_SWAP, action: <button data-action="sign">Sign anyway</button> } as SignCardProps;
    const html = renderToStaticMarkup(<SignCard {...props} />);
    expect(html).not.toContain("Sign anyway");
    expect(signButton(html)).toContain('disabled=""');
  });

  it("turns the sign button on only when everything holds", () => {
    expect(canSign(READY)).toBe(true);
    expect(signButton(renderToStaticMarkup(<SignCard {...READY} />))).not.toContain("disabled");

    const off: Array<[string, SignCardProps]> = [
      ["no gate", { ...READY, sign: undefined }],
      ["nothing sent", { ...READY, sends: undefined }],
      ["nothing received", { ...READY, receives: undefined }],
      ["simulation pending", { ...READY, sign: { simulation: "pending", onSign: noop } }],
      ["simulation failed", { ...READY, sign: { simulation: "failed", onSign: noop } }],
      ["no simulation", { ...READY, sign: { simulation: "none", onSign: noop } }],
      ["signing in flight", { ...READY, sign: { simulation: "passed", busy: true, onSign: noop } }],
      ["check stop", { ...READY, check: { tone: "stop", title: "Pool held" } }],
      ["check partial", { ...READY, check: { tone: "partial", title: "Some checks did not run" } }],
      ["no check", { ...READY, check: undefined }],
      ["wallet not ready", { ...READY, prerequisite: { label: "Switch to Base Sepolia", onClick: noop } }],
      ["already signed", { ...READY, outcome: { received: { amount: "+0.006", token: "ETH" }, tx: { hash: "0xabc", href: "https://example.org/tx/0xabc" } } }],
    ];
    for (const [why, props] of off) {
      expect(canSign(props), why).toBe(false);
      // Where a sign button is drawn at all, it is disabled.
      const button = signButton(renderToStaticMarkup(<SignCard {...props} />));
      if (button) expect(button, why).toContain('disabled=""');
    }
  });

  it("puts the wallet step in the button's place while the wallet is not ready", () => {
    const html = renderToStaticMarkup(<SignCard {...READY} prerequisite={{ label: "Connect wallet", onClick: noop }} />);
    expect(html).toContain('data-action="prerequisite"');
    expect(html).toContain("Connect wallet");
    expect(html).not.toContain('data-action="sign"');
  });

  it("shows what arrived and the transaction after signing, with no sign button", () => {
    const html = renderToStaticMarkup(
      <SignCard {...READY} outcome={{ received: { amount: "+0.006045", token: "ETH" }, tx: { hash: "0x" + "ab".repeat(32), href: "https://sepolia.basescan.org/tx/0xab" } }} />,
    );
    expect(rows(html)).toEqual(["sends", "receives", "route", "cost", "received", "tx", "check"]);
    expect(html).toContain("+0.006045 ETH");
    expect(html).toContain('href="https://sepolia.basescan.org/tx/0xab"');
    expect(html).not.toContain('data-action="sign"');
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
