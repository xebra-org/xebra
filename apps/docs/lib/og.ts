/**
 * The longest description an Open Graph image shows. At 26px across 960px that is about three
 * lines; the image also clamps to three lines, so this only keeps the text it lays out short.
 */
export const OG_DESCRIPTION_MAX = 180;

/** Cut a page description to `max` characters at a word break, ending in an ellipsis. */
export function clampDescription(text: string, max = OG_DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > max / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:!?-]+$/, "")}…`;
}
