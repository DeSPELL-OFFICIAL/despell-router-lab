import Link from "next/link";
import { CONTESTS } from "@/lib/contests";
import { SignCard } from "@/components/sign-card/sign-card";
import { EMPTY_SWAP } from "@/components/sign-card/examples";

export default function Home() {
  return (
    <main className="lab-main">
      <section className="lab-hero" aria-labelledby="hero-h">
        <div className="lab-hero-copy">
          <p className="lab-eyebrow">DeSpell AI router · hackathons, December 2026</p>
          <h1 id="hero-h" className="lab-h1">
            One card shows what leaves your wallet, what comes in and the route. <em>Nothing moves until you sign it.</em>
          </h1>
          <p className="lab-lede">
            The router behind that card watches every pool it might send you through, and tightens or closes a pool the moment something about it changes. Each demo below adds one line to the same card.
          </p>
          <ul className="lab-rules">
            <li>Money moves only when you sign.</li>
            <li>Marks only tighten. A pool reopens only after test trades pass again.</li>
            <li>
              <Link href="/swap">Sign a test-network swap with your own wallet</Link>
            </li>
            <li>
              <Link href="/card">See the card in both themes</Link>
            </li>
          </ul>
        </div>
        <SignCard {...EMPTY_SWAP} />
      </section>

      <section aria-labelledby="demos-h" style={{ display: "grid", gap: 16 }}>
        <h2 id="demos-h" className="lab-h2">
          Four demos
        </h2>
        <div className="lab-tiles">
          {CONTESTS.map((c) => (
            <Link key={c.slug} href={`/${c.slug}`} className="lab-tile">
              <b>{c.hackathon}</b>
              <p>{c.pitch}</p>
              <span className="lab-tile-foot">
                <span className="ds-mono">{c.folder}</span>
                <span>Open →</span>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
