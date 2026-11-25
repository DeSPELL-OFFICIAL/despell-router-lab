import type { Metadata } from "next";
import { SignCard } from "@/components/sign-card/sign-card";
import { EMPTY_SWAP, EXAMPLE_SWAP } from "@/components/sign-card/examples";

export const metadata: Metadata = { title: "Signing card" };

const THEMES = ["dark", "light"] as const;

export default function CardPage() {
  return (
    <main className="lab-main">
      <div style={{ display: "grid", gap: 12 }}>
        <p className="lab-eyebrow">Shared part</p>
        <h1 className="lab-h1">The signing card</h1>
        <p className="lab-lede">
          480 wide: sends and receives, one route line, cost folded, one check box, then the decision row. The empty card is what a page shows before a quote; the example uses made-up values.
        </p>
      </div>
      <div className="lab-themes">
        {THEMES.map((theme) => (
          <section key={theme} data-theme={theme} className="lab-theme-pane" aria-label={`${theme} theme`}>
            <p className="lab-eyebrow">{theme}</p>
            <SignCard {...EMPTY_SWAP} />
            <SignCard {...EXAMPLE_SWAP} />
          </section>
        ))}
      </div>
    </main>
  );
}
