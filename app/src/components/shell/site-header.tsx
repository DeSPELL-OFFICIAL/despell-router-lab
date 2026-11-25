import Link from "next/link";
import { CONTESTS } from "@/lib/contests";
import { ThemeToggle } from "./theme-toggle";
import { WalletSlot } from "./wallet-slot";

export function SiteHeader() {
  return (
    <header className="lab-header">
      <Link href="/" className="lab-brand">
        DeSpell <span className="lab-brand-sub">Router Lab</span>
      </Link>
      <nav aria-label="Hackathons" className="lab-nav">
        {CONTESTS.map((c) => (
          <Link key={c.slug} href={`/${c.slug}`}>
            {c.hackathon}
          </Link>
        ))}
      </nav>
      <div className="lab-header-end">
        <ThemeToggle />
        <WalletSlot />
      </div>
    </header>
  );
}
