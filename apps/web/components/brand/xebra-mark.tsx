import { cn } from "../ui/cn";

/**
 * The Xebra mark: a crossing.
 *
 * Four stripes of a zebra crossing seen from the kerb, narrowing as they run away from you: a
 * safe way across, which is what the bridge is for. The same drawing as `public/icon.svg`, here
 * in `currentColor` inside a quiet frame so it sits on any surface. Plain paths, no ids, so it
 * can appear more than once on a page.
 */
export function XebraMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={cn("h-8 w-8", className)}>
      <rect
        x="1.2"
        y="1.2"
        width="61.6"
        height="61.6"
        rx="14"
        className="fill-bone/[0.06] stroke-bone/25"
        strokeWidth="2.4"
      />
      <g fill="currentColor">
        <path d="M9 53H16.88L23.14 17H18.52Z" />
        <path d="M21.71 53H29.59L30.58 17H25.97Z" />
        <path d="M34.41 53H42.29L38.03 17H33.42Z" />
        <path d="M47.12 53H55L45.48 17H40.86Z" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark. The word is set tight and heavy; the mark carries the colour. */
export function XebraWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <XebraMark className="h-7 w-7 text-bone" />
      <span className="text-[0.95rem] font-semibold tracking-[-0.02em] text-bone">Xebra</span>
    </span>
  );
}
