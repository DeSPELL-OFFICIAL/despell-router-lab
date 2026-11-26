import type { Metadata } from "next";
import Link from "next/link";
import { XLayerCardDemo } from "@/components/circuit/xlayer-card-demo";
import { getContest } from "@/lib/contests";
import { circuitPageHref } from "@/lib/circuit/links";
import { GIWA_SEPOLIA } from "@/lib/swap/chains";

export const metadata: Metadata = { title: "X Layer TapeOut" };

export default async function Page(props: PageProps<"/xlayer">) {
  const c = getContest("xlayer");
  const demoMismatch = (await props.searchParams).demo === "mismatch";
  return (
    <main className="lab-main">
      <div style={{ display: "grid", gap: 12 }}>
        <p className="lab-eyebrow">{c.hackathon}</p>
        <h1 className="lab-h1">{c.pitch}</h1>
        <p className="lab-lede">
          Before the GIWA Sepolia card below can be signed, it asks the circuit on X Layer for its judgment of the pool the trade goes through, and compares it with the
          server&apos;s. If they differ, the card stops. The server&apos;s judgment here is a recorded sample; the router&apos;s past judgments are replayed through the circuit separately.{" "}
          <Link href={circuitPageHref(GIWA_SEPOLIA.pool.address, demoMismatch)}>See the pool&apos;s circuit</Link>.
        </p>
        {demoMismatch ? (
          <p className="lab-demo-note" role="note">
            Demo: the server&apos;s judgment of this pool is altered on purpose, to show what a mismatch does.{" "}
            <Link href="/xlayer">Back to the real one</Link>.
          </p>
        ) : (
          <p className="lab-note">
            <Link href="/xlayer?demo=mismatch">Show a mismatch</Link> (alters the server&apos;s judgment on this page only; it can only stop the card).
          </p>
        )}
      </div>
      <XLayerCardDemo demoMismatch={demoMismatch} />
    </main>
  );
}
