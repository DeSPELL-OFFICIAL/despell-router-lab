/*
  The four hackathons this app shows, in the order of the README table.
  Each one gets a route at /<slug>; its code lives in the repository folder
  of the same name and is imported into that route.
*/

export type Contest = {
  slug: "reactive" | "xlayer" | "ethglobal" | "cmc";
  /** Repository folder holding this contest's code. */
  folder: string;
  hackathon: string;
  /** One line on what the demo shows. */
  pitch: string;
  /** First day of work, ISO date. */
  from: string;
};

export const CONTESTS: readonly Contest[] = [
  {
    slug: "reactive",
    folder: "reactive/",
    hackathon: "Reactive Omni",
    pitch: "A pool setting changes, and a Reactive contract marks that pool as narrowed on-chain within seconds. Quotes leave the marked pool out.",
    from: "2026-11-26",
  },
  {
    slug: "xlayer",
    folder: "xlayer/",
    hackathon: "X Layer TapeOut",
    pitch: "The router's pool judgment rules as a TapeOut NAND circuit on X Layer, so anyone can reproduce each judgment.",
    from: "2026-11-26",
  },
  {
    slug: "ethglobal",
    folder: "ethglobal/",
    hackathon: "ETHGlobal Agentic Markets",
    pitch: "A card waiting for your signature is held when its pool changes, with a receipt saying why.",
    from: "2026-12-03",
  },
  {
    slug: "cmc",
    folder: "cmc/",
    hackathon: "CoinMarketCap API",
    pitch: "Tokenized wrappers of one stock ranked by what you actually receive, using CMC RWA prices plus route cost.",
    from: "2026-11-26",
  },
];

export function getContest(slug: Contest["slug"]): Contest {
  const contest = CONTESTS.find((c) => c.slug === slug);
  if (!contest) throw new Error(`Unknown contest: ${slug}`);
  return contest;
}
