import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/components/shell/site-header";
import { themeScript } from "@/components/shell/theme-script";
import { WalletProviders } from "@/components/wallet/providers";
import "@/styles/tokens.css";
import "@/styles/ds.css";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://lab.despell.io"),
  title: { default: "DeSpell Router Lab", template: "%s · DeSpell Router Lab" },
  description: "Hackathon demos for the DeSpell AI router. One card shows what leaves your wallet, what comes in and the route, and nothing moves until you sign it.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <WalletProviders>
          <SiteHeader />
          {children}
        </WalletProviders>
      </body>
    </html>
  );
}
