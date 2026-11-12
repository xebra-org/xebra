import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { llms, loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { transformerTwoslash } from "fumadocs-twoslash";
import { openapi, operationSlug } from "./openapi";
import { docsRoute } from "./shared";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
    // Fumadocs' defaults, plus Twoslash: every ```ts twoslash block is compiled against the real
    // @xebra/sdk, so a sample that would not compile fails the build.
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: {
        themes: { light: "github-light", dark: "vesper" },
        transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), transformerTwoslash()],
      },
    }),
  },
  meta: { schema: metaSchema },
});

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({
      baseDir: "api",
      per: "operation",
      groupBy: "tag",
      meta: true,
      // listRoutes -> list-routes, so the URLs read like the rest of the site.
      name: (output) =>
        output.type === "operation"
          ? operationSlug(output.item.method, output.item.path)
          : output.item.name,
    }),
  },
  {
    baseUrl: docsRoute,
    plugins: [openapi.loaderPlugin()],
  },
);

export const docsLlms = llms(source, {
  renderPage: async (page) => {
    if (page.type === "openapi") {
      return `# ${page.data.title} (${page.url})

\`\`\`json
${JSON.stringify(page.data.getSchema().bundled, null, 2)}
\`\`\``;
    }
    return `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`;
  },
});
