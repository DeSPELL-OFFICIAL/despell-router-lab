import Link from "next/link";
import { getContest, type Contest } from "@/lib/contests";

/* Stand-in for a contest page until that contest's own screen replaces it. */
export function ContestPlaceholder({ slug }: { slug: Contest["slug"] }) {
  const c = getContest(slug);
  return (
    <main className="lab-main lab-narrow">
      <p className="lab-eyebrow">{c.hackathon}</p>
      <h1 className="lab-h1">{c.pitch}</h1>
      <p className="lab-lede">
        This demo is being built in <code className="ds-mono">{c.folder}</code> from {c.from}. Its screen will appear here.
      </p>
      <p>
        <Link href="/card" className="ds-btn">
          See the signing card it builds on
        </Link>
      </p>
    </main>
  );
}
