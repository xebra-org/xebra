import { describe, expect, it } from "vitest";
import robots from "../../app/robots";
import { ARC_PEERS, EVM_ARC_PEERS, EVM_CHAINS } from "../evm-chains";
import type { DomainForwardConfig } from "../forward-fee";
import { buildDocs } from "./docs";
import { articleLd, breadcrumbLd, faqLd, ogImagePath } from "./json-ld";
import { llmsFullTxt, llmsTxt } from "./llms";
import { absoluteMarkdown, renderMarkdown } from "./markdown";
import { OG_PAGES, ogImageParams } from "./og";
import { type SiteFlags, candidateSlugs, offeredRoutes, parseSlug } from "./routes";

/** Production as built on 2026-10-15: Arc sends everywhere, Stellar names every chain. */
const PRODUCTION: SiteFlags = {
  arcEnabled: true,
  stellarSendsTo: EVM_ARC_PEERS,
  evmRoutes: { arcSendsTo: ARC_PEERS, arcReceivesFrom: [] },
  useWrapper: false,
};

const cfg = (cap: bigint, forward = true): DomainForwardConfig => ({
  forward,
  maxForwardFee: cap,
  accountCreation: false,
  maxForwardFeeNewAccount: 0n,
});

/** The wrapper's live list on 2026-10-15: Solana and Arc. */
const LIVE = new Map<number, DomainForwardConfig>([
  [
    5,
    {
      forward: true,
      maxForwardFee: 2_500_000n,
      accountCreation: true,
      maxForwardFeeNewAccount: 4_500_000n,
    },
  ],
  [26, cfg(1_000_000n)],
]);

describe("which routes get a page", () => {
  it("is exactly the routes the bridge offers today", () => {
    const slugs = offeredRoutes(LIVE, PRODUCTION).map((r) => r.slug);
    expect(slugs.slice(0, 2)).toEqual(["stellar-to-solana", "stellar-to-arc"]);
    expect(slugs).not.toContain("stellar-to-base");
    expect(slugs.filter((s) => s.startsWith("arc-to-"))).toHaveLength(15);
    expect(slugs).toHaveLength(17);
  });

  it("adds a Stellar chain once the wrapper commits it, at the committed cap", () => {
    const withBase = new Map(LIVE).set(EVM_CHAINS.base.cctpDomainId, cfg(2_500_000n));
    const base = offeredRoutes(withBase, PRODUCTION).find((r) => r.slug === "stellar-to-base");
    expect(base?.deliveryCapUnits).toBe(250_000);
    expect(base?.via).toBe("stellar-wrapper");
  });

  it("drops a destination the wrapper has switched off", () => {
    const off = new Map(LIVE).set(26, cfg(1_000_000n, false));
    expect(offeredRoutes(off, PRODUCTION).map((r) => r.slug)).not.toContain("stellar-to-arc");
  });

  it("falls back to Solana and Arc at their recorded caps when the contract cannot be read", () => {
    const routes = offeredRoutes(null, PRODUCTION).filter((r) => r.from === "stellar");
    expect(routes.map((r) => [r.slug, r.deliveryCapUnits, r.deliveryCapNewAccountUnits])).toEqual([
      ["stellar-to-solana", 250_000, 450_000],
      ["stellar-to-arc", 100_000, null],
    ]);
  });

  it("offers nothing around Arc in a build that switches it off", () => {
    const stellarOnly = { ...PRODUCTION, evmRoutes: { arcSendsTo: [], arcReceivesFrom: [] } };
    expect(offeredRoutes(LIVE, stellarOnly).every((r) => r.from === "stellar")).toBe(true);
  });

  it("gives every route, offered or not yet, an image, and parses its own slugs", () => {
    const images = new Set(ogImageParams().map((p) => `/og/${p.path.join("/")}`));
    for (const slug of candidateSlugs()) {
      expect(images.has(`/og/bridge/${slug}`)).toBe(true);
      expect(parseSlug(slug)).not.toBeNull();
    }
    for (const r of offeredRoutes(new Map([...LIVE, [6, cfg(2_500_000n)]]), PRODUCTION)) {
      expect(candidateSlugs()).toContain(r.slug);
    }
    expect(parseSlug("stellar-to-ethereum")).toBeNull();
  });
});

describe("the written pages", () => {
  const routes = offeredRoutes(LIVE, PRODUCTION);
  const docs = buildDocs(routes, false);
  const paths = new Set(docs.map((d) => d.path));

  it("are unique, titled, and each has its Markdown copy and image", () => {
    expect(paths.size).toBe(docs.length);
    const images = new Set(ogImageParams().map((p) => `/og/${p.path.join("/")}`));
    for (const d of docs) {
      expect(d.markdown.startsWith("# ")).toBe(true);
      expect(d.markdownPath).toBe(d.path === "/" ? "/index.md" : `${d.path}.md`);
      expect(images.has(ogImagePath(d.path))).toBe(true);
      expect(d.description.length).toBeGreaterThan(50);
      // Search results cut a description off at about 160 characters.
      expect(d.description.length, d.path).toBeLessThanOrEqual(160);
      expect(`${d.title} · Xebra`.length, d.path).toBeLessThanOrEqual(60);
    }
    expect(Object.keys(OG_PAGES)).toEqual(
      expect.arrayContaining([
        "home",
        "how-it-works",
        "fees",
        "routes",
        "security",
        "faq",
        "claim",
      ]),
    );
  });

  it("link only to pages that exist", () => {
    for (const d of docs) {
      for (const [, href] of d.markdown.matchAll(/\]\((\/[^)#?]*)[^)]*\)/g)) {
        expect(paths.has(href as string), `${d.path} links to ${href}`).toBe(true);
      }
    }
  });

  it("say there is no Xebra fee from Arc until the wrapper is switched on, and the fee after", () => {
    const direct = docs.find((d) => d.path === "/bridge/arc-to-base");
    expect(direct?.markdown).toContain("None: you pay Circle's delivery fee only");
    const wrapped = buildDocs(offeredRoutes(LIVE, { ...PRODUCTION, useWrapper: true }), true).find(
      (d) => d.path === "/bridge/arc-to-base",
    );
    expect(wrapped?.markdown).toContain("0.1% of the amount, at least 0.30 USDC");
  });

  it("are all listed in llms.txt, and all in llms-full.txt", () => {
    const index = llmsTxt(docs);
    const full = llmsFullTxt(docs);
    expect(index.startsWith("# Xebra\n\n> ")).toBe(true);
    for (const d of docs) {
      expect(index).toContain(`https://xebra.exchange${d.markdownPath}`);
      expect(full).toContain(d.markdown.split("\n")[0] as string);
    }
    expect(full).not.toMatch(/\]\(\/[a-z]/);
  });
});

describe("structured data", () => {
  const docs = buildDocs(offeredRoutes(LIVE, PRODUCTION), false);

  it("parses and names what each page is", () => {
    const route = docs.find((d) => d.path === "/bridge/stellar-to-solana");
    if (!route) throw new Error("missing route page");
    const crumbs = breadcrumbLd(route);
    expect(crumbs.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(crumbs.itemListElement.at(-1)?.item).toBe(
      "https://xebra.exchange/bridge/stellar-to-solana",
    );

    const article = articleLd(route, "2026-10-15");
    expect(article.image).toBe("https://xebra.exchange/og/bridge/stellar-to-solana");
    expect(JSON.parse(JSON.stringify(article))["@type"]).toBe("TechArticle");
  });

  it("answers each FAQ question in plain text", () => {
    const faq = docs.find((d) => d.path === "/faq")?.faq ?? [];
    const ld = faqLd(faq);
    expect(ld.mainEntity.length).toBeGreaterThanOrEqual(10);
    for (const q of ld.mainEntity) expect(q.acceptedAnswer.text).not.toMatch(/\]\(/);
  });
});

describe("markdown", () => {
  it("gives headings ids and opens links off the site in a new tab", () => {
    const html = renderMarkdown(
      "## What it costs\n\n[CCTP](https://developers.circle.com) and [fees](/fees)",
    );
    expect(html).toContain('<h2 id="what-it-costs">What it costs</h2>');
    expect(html).toContain(
      'href="https://developers.circle.com" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain('<a href="/fees">fees</a>');
  });

  it("makes links absolute in the copies read off the site", () => {
    expect(absoluteMarkdown("see [fees](/fees) and [CCTP](https://x.y)")).toBe(
      "see [fees](https://xebra.exchange/fees) and [CCTP](https://x.y)",
    );
  });
});

describe("robots.txt", () => {
  it("closes everything outside production, so a preview never competes with the site", () => {
    // VERCEL_ENV is not "production" under test.
    expect(robots().rules).toEqual([{ userAgent: "*", disallow: "/" }]);
  });
});
