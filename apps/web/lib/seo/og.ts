import { candidateSlugs } from "./routes";

interface OgText {
  eyebrow: string;
  title: string;
  sub: string;
}

/**
 * What each page's link-preview image says (`app/og/[...path]/route.tsx`). Route pages are drawn
 * from their two chains instead.
 */
export const OG_PAGES: Record<string, OgText> & { home: OgText } = {
  home: {
    eyebrow: "Native USDC · Circle CCTP",
    title: "Burned here. Minted there.",
    sub: "Native USDC between Stellar, Solana, Arc and EVM chains.",
  },
  "how-it-works": {
    eyebrow: "How it works",
    title: "Burn, attest, mint.",
    sub: "Circle burns USDC on one chain and mints it on the other.",
  },
  fees: {
    eyebrow: "Fees",
    title: "One fee, shown before you sign.",
    sub: "Circle's delivery fee is paid out of ours, not on top.",
  },
  routes: {
    eyebrow: "Routes",
    title: "Every route, one page each.",
    sub: "Stellar, Solana, Arc and fourteen EVM chains.",
  },
  security: {
    eyebrow: "Security",
    title: "Contracts, custody, limits.",
    sub: "Open source, capped, paused in one call, changed only after 48 hours.",
  },
  faq: {
    eyebrow: "Questions",
    title: "Before you move money.",
    sub: "Native or wrapped, fees, timing, and what if it gets stuck.",
  },
  claim: {
    eyebrow: "Claim",
    title: "Finish a stuck transfer yourself.",
    sub: "Circle's attestation is public. Anyone can submit the mint.",
  },
};

/** Every image path: each page's, and each candidate route's. `seo.test.ts` checks none is missing. */
export function ogImageParams(): Array<{ path: string[] }> {
  return [
    ...Object.keys(OG_PAGES).map((key) => ({ path: [key] })),
    ...candidateSlugs().map((slug) => ({ path: ["bridge", slug] })),
  ];
}
