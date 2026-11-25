import { createConfig, http } from "wagmi";
import { baseSepolia, giwaSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/*
  Browser wallets only: wallets that announce themselves (EIP-6963) plus the
  plain injected provider as a fallback. No WalletConnect, no hosted wallet
  SDKs, so the app ships no third-party wallet code and needs no project id.

  Reads (quotes, balances, simulations, receipts) go to each chain's public
  RPC; transactions go through the user's wallet.
*/

export const LAB_CHAINS = [baseSepolia, giwaSepolia] as const;

export function makeWagmiConfig() {
  return createConfig({
    chains: LAB_CHAINS,
    connectors: [injected()],
    multiInjectedProviderDiscovery: true,
    ssr: true,
    transports: {
      [baseSepolia.id]: http(),
      [giwaSepolia.id]: http(),
    },
  });
}

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof makeWagmiConfig>;
  }
}
