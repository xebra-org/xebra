import { HomeClient } from "../components/bridge/home-client";
import { HomeSections } from "../components/content/home-sections";
import { JsonLd, faqLd, webApplicationLd } from "../lib/seo/json-ld";
import { getDoc, getDocs, siteFaq } from "../lib/seo/live";
import { pageMetadata } from "../lib/site";

/**
 * The bridge, with what a newcomer (or a search engine) needs to know rendered below it on the
 * server: how it works, which routes are live, and the questions people ask first.
 */
export const revalidate = 3600;

/** The questions shown on the home page; all of them are on /faq. */
const HOME_FAQ = siteFaq().slice(0, 5);

export async function generateMetadata() {
  const doc = await getDoc("/");
  return pageMetadata({
    description: doc?.description ?? "",
    path: "/",
    image: "/og/home",
    markdownPath: "/index.md",
  });
}

export default async function HomePage() {
  const routes = (await getDocs()).flatMap((d) => (d.route ? [d.route] : []));
  return (
    <>
      <HomeClient>
        <HomeSections routes={routes} faq={HOME_FAQ} />
      </HomeClient>
      <JsonLd data={[webApplicationLd(), faqLd(HOME_FAQ)]} />
    </>
  );
}
