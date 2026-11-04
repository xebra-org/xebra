import { LOGO_PATH, SITE_DESCRIPTION, SITE_NAME, SITE_URL, SOURCE_URL, absoluteUrl } from "../site";
import type { Doc } from "./docs";
import type { Faq } from "./faq";

/**
 * Structured data (schema.org JSON-LD): what search engines and assistants read to know what a page
 * is, rather than inferring it from the layout.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  // `<` is escaped so no string in the data can close the script element early.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own serialised JSON, escaped above.
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE_NAME,
    url: SITE_URL,
    logo: absoluteUrl(LOGO_PATH),
    sameAs: [SOURCE_URL],
  };
}

export function websiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": SITE_ID,
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    publisher: { "@id": ORG_ID },
    inLanguage: "en",
  };
}

export function webApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any (web browser)",
    browserRequirements: "A browser wallet: Freighter or LOBSTR for Stellar, or any EVM wallet",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": ORG_ID },
  };
}

export function breadcrumbLd(doc: Doc) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: doc.breadcrumb.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path),
    })),
  };
}

export function articleLd(doc: Doc, dateModified: string) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: doc.title,
    description: doc.description,
    url: absoluteUrl(doc.path),
    mainEntityOfPage: absoluteUrl(doc.path),
    image: absoluteUrl(ogImagePath(doc.path)),
    dateModified,
    inLanguage: "en",
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    isPartOf: { "@id": SITE_ID },
  };
}

export function faqLd(faq: Faq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: stripMarkdown(f.a) },
    })),
  };
}

/** Where a page's link-preview image is served: `/og/fees`, `/og/home` for the home page. */
export function ogImagePath(path: string): string {
  return path === "/" ? "/og/home" : `/og${path}`;
}

/** Answers carry Markdown links; structured data wants plain text. */
export function stripMarkdown(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "");
}
