"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { makeWagmiConfig } from "./config";

type PickerState = { open: boolean; setOpen: (open: boolean) => void };

const PickerContext = createContext<PickerState | null>(null);

/** Opens the header's wallet list from anywhere (a card's Connect wallet button). */
export function useWalletPicker() {
  const ctx = useContext(PickerContext);
  if (!ctx) throw new Error("useWalletPicker outside WalletProviders");
  return ctx;
}

export function WalletProviders({ children }: { children: ReactNode }) {
  const [config] = useState(makeWagmiConfig);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  const picker = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <PickerContext.Provider value={picker}>{children}</PickerContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
