import { ThemeToggle } from "./theme-toggle";
import { WalletSlot } from "./wallet-slot";

/*
  No links between demos: judges reach each contest page by its own address,
  so the header carries only the wordmark (plain text), the theme switch and
  the wallet slot.
*/
export function SiteHeader() {
  return (
    <header className="lab-header">
      <span className="lab-brand">
        DeSpell <span className="lab-brand-sub">Router Lab</span>
      </span>
      <div className="lab-header-end">
        <ThemeToggle />
        <WalletSlot />
      </div>
    </header>
  );
}
