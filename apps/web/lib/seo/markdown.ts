import { Marked, type Tokens } from "marked";
import { SITE_URL } from "../site";

/**
 * Markdown to HTML for the written pages, at build time, from our own documents only (`docs.ts`).
 *
 * Headings get stable ids, so a section can be linked to and cited. Links off the site open in a new
 * tab without handing it the opener.
 */
const marked = new Marked({ gfm: true });

marked.use({
  renderer: {
    heading(
      this: { parser: { parseInline(t: Tokens.Heading["tokens"]): string } },
      token: Tokens.Heading,
    ) {
      const text = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${slugify(token.text)}">${text}</h${token.depth}>\n`;
    },
    link(this: { parser: { parseInline(t: Tokens.Link["tokens"]): string } }, token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const external = /^https?:\/\//.test(token.href) && !token.href.startsWith(SITE_URL);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${escapeAttr(token.href)}"${attrs}>${text}</a>`;
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/**
 * The same document for reading outside the site: every link made absolute, since an assistant
 * quoting `/fees` out of context has nowhere to resolve it against.
 */
export function absoluteMarkdown(markdown: string): string {
  return markdown.replace(/\]\((\/[^)]*)\)/g, (_, path: string) => `](${SITE_URL}${path})`);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
