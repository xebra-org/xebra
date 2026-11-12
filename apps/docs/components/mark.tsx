/** The crossing mark: four stripes narrowing toward the far kerb. Same paths as public/icon.svg. */
export function XebraMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <g fill="currentColor">
        <path d="M9 53H16.88L23.14 17H18.52Z" />
        <path d="M21.71 53H29.59L30.58 17H25.97Z" />
        <path d="M34.41 53H42.29L38.03 17H33.42Z" />
        <path d="M47.12 53H55L45.48 17H40.86Z" />
      </g>
    </svg>
  );
}
