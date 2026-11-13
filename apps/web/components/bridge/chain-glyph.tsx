import { cn } from "../ui/cn";

/**
 * Each chain's own mark, as the chain publishes it.
 *
 * These used to be redrawn abstractions in a single stroke weight, to keep the monochrome plate
 * monochrome. People do not recognise an abstraction of a chain; they recognise its logo, and on a
 * screen that moves money the recognition is worth more than the palette. Each mark sits in a round
 * (Arc: rounded-square, as its icon is drawn) tile so different backgrounds read as a row of
 * badges instead of stray rectangles.
 *
 * Files are 96px PNGs in /public/chains, sized for a 24px slot at 2x. Sources: Arc from
 * arc.network's own site icon; Unichain, Codex, World Chain and Ink from DefiLlama's chain icons;
 * every other chain (Aptos included) from the Trust Wallet assets repository.
 */
export type Chain =
  | "stellar"
  | "sui"
  | "aptos"
  | "solana"
  | "arc"
  | "avalanche"
  | "optimism"
  | "arbitrum"
  | "base"
  | "polygon"
  | "unichain"
  | "codex"
  | "sonic"
  | "worldchain"
  | "monad"
  | "sei"
  | "xdc"
  | "hyperevm"
  | "ink";

const SRC: Record<Chain, string> = {
  stellar: "/chains/stellar.png",
  sui: "/chains/sui.png",
  aptos: "/chains/aptos.png",
  solana: "/chains/solana.png",
  arc: "/chains/arc.png",
  avalanche: "/chains/avalanche.png",
  optimism: "/chains/optimism.png",
  arbitrum: "/chains/arbitrum.png",
  base: "/chains/base.png",
  polygon: "/chains/polygon.png",
  unichain: "/chains/unichain.png",
  codex: "/chains/codex.png",
  sonic: "/chains/sonic.png",
  worldchain: "/chains/worldchain.png",
  monad: "/chains/monad.png",
  sei: "/chains/sei.png",
  xdc: "/chains/xdc.png",
  hyperevm: "/chains/hyperevm.png",
  ink: "/chains/ink.png",
};

export function ChainGlyph({ chain, className }: { chain: Chain; className?: string }) {
  return (
    <img
      src={SRC[chain]}
      alt=""
      width={24}
      height={24}
      aria-hidden="true"
      draggable={false}
      className={cn(
        "h-5 w-5 shrink-0 select-none object-cover",
        chain === "arc" ? "rounded-[22%]" : "rounded-full",
        className,
      )}
    />
  );
}

export const CHAIN_NAMES: Record<Chain, string> = {
  stellar: "Stellar",
  sui: "Sui",
  aptos: "Aptos",
  solana: "Solana",
  arc: "Arc",
  avalanche: "Avalanche",
  optimism: "OP Mainnet",
  arbitrum: "Arbitrum",
  base: "Base",
  polygon: "Polygon",
  unichain: "Unichain",
  codex: "Codex",
  sonic: "Sonic",
  worldchain: "World Chain",
  monad: "Monad",
  sei: "Sei",
  xdc: "XDC",
  hyperevm: "HyperEVM",
  ink: "Ink",
};
