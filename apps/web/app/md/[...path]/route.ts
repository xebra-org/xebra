import { getDocs } from "../../../lib/seo/live";
import { absoluteMarkdown } from "../../../lib/seo/markdown";

/**
 * Each page's Markdown copy. Reached as `<page>.md` (`/fees.md`, `/index.md` for the home page)
 * through a rewrite in `next.config.ts`. Not indexed: the HTML page is the one to rank.
 */
export const revalidate = 3600;
export const dynamicParams = true;

const segments = (path: string) => (path === "/" ? ["index"] : path.slice(1).split("/"));

export async function generateStaticParams() {
  return (await getDocs()).map((d) => ({ path: segments(d.path) }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const wanted = path.join("/");
  const doc = (await getDocs()).find((d) => segments(d.path).join("/") === wanted);
  if (!doc) return new Response("Not found\n", { status: 404 });
  return new Response(absoluteMarkdown(doc.markdown), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-robots-tag": "noindex",
    },
  });
}
