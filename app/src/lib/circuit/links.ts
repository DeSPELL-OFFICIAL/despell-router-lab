import type { Route } from "next";

/** The circuit page for a pool; `demoMismatch` carries the mismatch demo along. */
export function circuitPageHref(pool: string, demoMismatch = false): Route {
  return `/xlayer/pools/${pool}${demoMismatch ? "?demo=mismatch" : ""}` as Route;
}
