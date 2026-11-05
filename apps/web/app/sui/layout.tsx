import type { Metadata } from "next";
import type React from "react";

// A mainnet pilot behind a switch. Not for a search engine until it has carried real transfers.
export const metadata: Metadata = {
  title: "Send USDC from Sui to Stellar",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
