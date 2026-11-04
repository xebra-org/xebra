import { getDocs } from "../../lib/seo/live";
import { llmsTxt } from "../../lib/seo/llms";

export const revalidate = 3600;

export async function GET() {
  return new Response(llmsTxt(await getDocs()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
