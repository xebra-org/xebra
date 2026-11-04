import { SITE_DESCRIPTION, SITE_URL, SOURCE_URL, absoluteUrl } from "../site";
import type { Doc } from "./docs";
import { FEES } from "./facts";
import { absoluteMarkdown } from "./markdown";

/**
 * `llms.txt` (llmstxt.org): a short index an assistant reads first, pointing at the Markdown copy of
 * every page. Built from the same documents as the pages, so it cannot fall out of step with them.
 */
export function llmsTxt(docs: Doc[]): string {
  const line = (d: Doc) => `- [${d.title}](${absoluteUrl(d.markdownPath)}): ${d.description}`;
  const of = (section: Doc["section"]) => docs.filter((d) => d.section === section).map(line);
  return `# Xebra

> ${SITE_DESCRIPTION}

Key facts, as of ${FEES.asOf}:

- Website: ${SITE_URL}. Mainnet only. The asset is native USDC, moved by Circle's Cross-Chain Transfer Protocol (CCTP): burned on one chain, minted by Circle on the other.
- From Stellar, Xebra's fee is ${FEES.bps / 100}% of the amount, at least ${FEES.minFeeUsdc} USDC; Circle's delivery fee is paid out of it. Transfers through Xebra's contracts are ${FEES.minTransferUsdc} to ${FEES.maxTransferUsdc} USDC.
- Delivery is by Circle's Forwarding Service, usually within minutes. A transfer that is not delivered can be completed by anyone at ${absoluteUrl("/claim")}.
- The contracts are open source (${SOURCE_URL}) and have not had an external audit.

## Docs

${[...of("overview"), ...of("docs")].join("\n")}

## Routes

${of("routes").join("\n")}

## Optional

- [Everything above in one file](${absoluteUrl("/llms-full.txt")})
- [Source code](${SOURCE_URL})
- [Security policy](${SOURCE_URL}/blob/main/SECURITY.md)
`;
}

/** Every page's Markdown, in order, for an assistant that wants the whole site in one read. */
export function llmsFullTxt(docs: Doc[]): string {
  return docs
    .map((d) => `<!-- ${absoluteUrl(d.path)} -->\n\n${absoluteMarkdown(d.markdown).trim()}`)
    .join("\n\n---\n\n")
    .concat("\n");
}
