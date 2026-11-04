import Link from "next/link";
import { notFound } from "next/navigation";
import { DocPage, docMetadata } from "../../../components/content/doc-page";
import { ArrowRight } from "../../../components/ui/icons";
import { getDocs } from "../../../lib/seo/live";
import { ENDPOINT_NAMES } from "../../../lib/seo/routes";

/**
 * One page per route the bridge offers: `/bridge/stellar-to-solana`. Built for the routes live at
 * deploy time and regenerated hourly, so a Stellar chain committed on the contract after a deploy
 * gets its page within the hour. A route the bridge does not offer is a 404, never a promise.
 */
export const revalidate = 3600;
export const dynamicParams = true;

export async function generateStaticParams() {
  return (await getDocs()).flatMap((d) => (d.route ? [{ route: d.route.slug }] : []));
}

type Props = { params: Promise<{ route: string }> };

export async function generateMetadata({ params }: Props) {
  const { route } = await params;
  return docMetadata(`/bridge/${route}`);
}

export default async function RoutePage({ params }: Props) {
  const { route } = await params;
  const doc = (await getDocs()).find((d) => d.path === `/bridge/${route}`);
  if (!doc?.route) notFound();
  const { from, to } = doc.route;
  return (
    <DocPage path={doc.path} navCurrent="/routes">
      <div className="mt-12 flex flex-col items-start gap-3 rounded-tray bg-bone/[0.03] p-6 ring-1 ring-inset ring-bone/[0.08]">
        <p className="text-sm text-bone/60">
          Ready to send from {ENDPOINT_NAMES[from]} to {ENDPOINT_NAMES[to]}?
        </p>
        <Link
          href={`/?from=${from}&to=${to}#bridge`}
          className="flex h-11 items-center gap-2.5 rounded-full bg-bone px-5 text-sm font-medium text-obsidian shadow-pill transition-colors duration-400 ease-haptic hover:bg-white"
        >
          Open the bridge on this route
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </DocPage>
  );
}
