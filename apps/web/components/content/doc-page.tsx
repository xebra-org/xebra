import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type React from "react";
import { env } from "../../lib/env";
import type { Doc } from "../../lib/seo/docs";
import { JsonLd, articleLd, breadcrumbLd, faqLd, ogImagePath } from "../../lib/seo/json-ld";
import { getDoc } from "../../lib/seo/live";
import { renderMarkdown } from "../../lib/seo/markdown";
import { CONTENT_UPDATED, pageMetadata } from "../../lib/site";
import { SiteFooter } from "../site/site-footer";
import { ContentHeader } from "../site/site-nav";

/** A written page's metadata, from its document. */
export async function docMetadata(path: string): Promise<Metadata> {
  const doc = await getDoc(path);
  if (!doc) return {};
  return pageMetadata({
    title: doc.title,
    description: doc.description,
    path: doc.path,
    image: ogImagePath(doc.path),
    markdownPath: doc.markdownPath,
  });
}

/**
 * A written page: its document rendered as HTML, in the site's frame, with its breadcrumb and
 * structured data. Server-rendered and static, so search engines and assistants read the whole page
 * without running anything.
 */
export async function DocPage({
  path,
  navCurrent,
  children,
}: {
  path: string;
  /** Which header link to mark as the current page. */
  navCurrent?: string;
  /** Rendered after the article: a route page's call to action, for instance. */
  children?: React.ReactNode;
}) {
  const doc = await getDoc(path);
  if (!doc) notFound();
  return (
    <>
      <ContentHeader {...(navCurrent ? { current: navCurrent } : {})} />
      <main id="content" className="mx-auto w-full max-w-2xl px-4 pt-14 sm:px-5 sm:pt-20">
        <Breadcrumbs doc={doc} />
        <article
          className="prose-x mt-8"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: our own Markdown (lib/seo/docs.ts), rendered at build time.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.markdown) }}
        />
        {children}
        <p className="mt-16 text-xs leading-relaxed text-bone/35">
          This page is also published as{" "}
          <a href={doc.markdownPath} className="underline underline-offset-2 hover:text-bone">
            Markdown
          </a>{" "}
          for assistants and tools. Updated {CONTENT_UPDATED}.
        </p>
      </main>
      <SiteFooter
        wrapperContractId={env.cctpWrapperContractId}
        contractLabel="Stellar contract"
        wide
      />
      <JsonLd
        data={[
          breadcrumbLd(doc),
          articleLd(doc, CONTENT_UPDATED),
          ...(doc.faq ? [faqLd(doc.faq)] : []),
        ]}
      />
    </>
  );
}

function Breadcrumbs({ doc }: { doc: Doc }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-xs text-bone/40">
        {doc.breadcrumb.map((c, i) => {
          const last = i === doc.breadcrumb.length - 1;
          return (
            <li key={c.path} className="flex items-center gap-2">
              {last ? (
                <span aria-current="page" className="text-bone/60">
                  {c.name}
                </span>
              ) : (
                <>
                  <Link href={c.path} className="transition-colors hover:text-bone">
                    {c.name}
                  </Link>
                  <span aria-hidden="true">/</span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
