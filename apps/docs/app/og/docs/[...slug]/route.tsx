import { getPageImageUrl } from "@/lib/shared";
import { source } from "@/lib/source";
import { notFound } from "next/navigation";
import { ImageResponse } from "next/og";

export const revalidate = false;

const BONE = "#f6f3ee";
const OBSIDIAN = "#0a0b0e";

const SECTION_NAMES: Record<string, string> = {
  guides: "Guides",
  concepts: "Concepts",
  sdk: "SDK",
  api: "API Reference",
  errors: "Errors",
  mcp: "MCP",
  changelog: "Changelog",
  quickstart: "Getting Started",
};

function getSection(slugs: string[]): string {
  if (slugs.length === 0) return "Documentation";
  const first = slugs[0]?.toLowerCase() ?? "";
  if (slugs.length === 1 && first === "quickstart") return "Getting Started";
  if (slugs.length === 1 && SECTION_NAMES[first]) return "Documentation";
  if (SECTION_NAMES[first]) return SECTION_NAMES[first];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export async function GET(_req: Request, { params }: RouteContext<"/og/docs/[...slug]">) {
  const { slug } = await params;
  const pageSlugs = slug.slice(0, -1);
  const page = source.getPage(pageSlugs);
  if (!page) notFound();

  const title = page.data.title || "Xebra Docs";
  const description = page.data.description;
  const section = getSection(pageSlugs);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: `radial-gradient(circle at 85% 0%, #1a1c22 0%, ${OBSIDIAN} 55%)`,
        color: BONE,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <svg width="48" height="48" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <rect
            width="64"
            height="64"
            rx="14"
            fill="#0a0b0e"
            stroke="rgba(246,243,238,0.2)"
            strokeWidth="2"
          />
          <g fill="#f6f3ee">
            <path d="M9 53H16.88L23.14 17H18.52Z" />
            <path d="M21.71 53H29.59L30.58 17H25.97Z" />
            <path d="M34.41 53H42.29L38.03 17H33.42Z" />
            <path d="M47.12 53H55L45.48 17H40.86Z" />
          </g>
        </svg>
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>Xebra Docs</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontSize: 18,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(246,243,238,0.5)",
          }}
        >
          {section}
        </span>
        <span
          style={{
            marginTop: 18,
            fontSize: title.length > 35 ? 54 : 68,
            fontWeight: 600,
            letterSpacing: "-0.035em",
            lineHeight: 1.05,
            maxWidth: 1040,
          }}
        >
          {title}
        </span>
        {description && (
          <span
            style={{
              marginTop: 20,
              fontSize: 26,
              color: "rgba(246,243,238,0.55)",
              maxWidth: 960,
              lineHeight: 1.35,
            }}
          >
            {description}
          </span>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 22, color: "rgba(246,243,238,0.6)" }}>docs.xebra.exchange</span>
        <div style={{ display: "flex", gap: 7 }}>
          {[3, 7, 2, 5, 3].map((w, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decoration, the zebra stripe.
              key={i}
              style={{
                width: w,
                height: 30,
                borderRadius: 2,
                background: "rgba(246,243,238,0.2)",
              }}
            />
          ))}
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
