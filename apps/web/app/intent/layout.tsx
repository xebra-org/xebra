import type { Metadata } from "next";
import type React from "react";

// Nothing here for a search engine: a rescue tool for one past bug, or a status page for the
// intent rail, which is not deployed.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
