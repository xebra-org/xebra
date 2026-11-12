// Fails when a built page links to a page or an anchor that does not exist.
// Run after `next build`: node scripts/check-links.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = ".next/server/app";
const REDIRECTS = [
  [/^\/$/, "/docs"],
  [/^\/api$/, "/docs/api"],
  [/^\/errors$/, "/docs/errors"],
  [/^\/errors\/(.+)$/, "/docs/errors/$1"],
];
// Built by route handlers, not as HTML pages.
const NON_HTML = [
  /^\/llms(-full)?\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/robots\.txt$/,
  /\.md$/,
  /^\/og\//,
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const pages = new Map();
for (const file of walk(root).filter((f) => f.endsWith(".html"))) {
  let route = `/${relative(root, file).replace(/\.html$/, "")}`;
  if (route.endsWith("/index")) route = route.slice(0, -6) || "/";
  const html = readFileSync(file, "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  pages.set(route, { html, ids });
}

const problems = [];
for (const [from, { html }] of pages) {
  for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
    if (href.startsWith("/_next/") || /\.(svg|png|ico|woff2?)$/.test(href)) continue;
    let [path, hash] = href.split("#");
    path = decodeURIComponent(path.replace(/\/$/, "") || "/");
    if (NON_HTML.some((re) => re.test(path))) continue;
    for (const [re, to] of REDIRECTS) if (re.test(path)) path = path.replace(re, to);
    const target = pages.get(path);
    if (!target) problems.push(`${from} -> ${href} (no such page)`);
    else if (hash && !target.ids.has(decodeURIComponent(hash)))
      problems.push(`${from} -> ${href} (no such anchor)`);
  }
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`${unique.length} broken link(s):\n${unique.join("\n")}`);
  process.exit(1);
}
console.log(`Links OK across ${pages.size} pages.`);
