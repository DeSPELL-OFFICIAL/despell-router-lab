import type { Metadata } from "next";
import { ContestPlaceholder } from "@/components/shell/contest-placeholder";

export const metadata: Metadata = { title: "ETHGlobal Agentic Markets" };

export default function Page() {
  return <ContestPlaceholder slug="ethglobal" />;
}
