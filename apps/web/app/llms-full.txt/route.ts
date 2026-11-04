import { getDocs } from "../../lib/seo/live";
import { llmsFullTxt } from "../../lib/seo/llms";

export const revalidate = 3600;

export async function GET() {
  return new Response(llmsFullTxt(await getDocs()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
