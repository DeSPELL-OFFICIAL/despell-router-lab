/*
  Where the wallet connection goes. DES-697 replaces this with a real
  connect button (external wallets, Base Sepolia and GIWA Sepolia).
*/
export function WalletSlot() {
  return (
    <button type="button" className="ds-btn" disabled aria-describedby="wallet-slot-note">
      Connect wallet
      <span id="wallet-slot-note" className="lab-sr-only">
        Wallet connection is not available yet.
      </span>
    </button>
  );
}
