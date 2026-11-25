import type { Metadata } from "next";
import { ContestPlaceholder } from "@/components/shell/contest-placeholder";

export const metadata: Metadata = { title: "Reactive Omni" };

export default function Page() {
  return <ContestPlaceholder slug="reactive" />;
}
