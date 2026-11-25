import type { Metadata } from "next";
import { ContestPlaceholder } from "@/components/shell/contest-placeholder";

export const metadata: Metadata = { title: "X Layer TapeOut" };

export default function Page() {
  return <ContestPlaceholder slug="xlayer" />;
}
