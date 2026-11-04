import { Suspense } from "react";
import { docMetadata } from "../../components/content/doc-page";
import { SiteFooter } from "../../components/site/site-footer";
import { env } from "../../lib/env";
import { JsonLd, breadcrumbLd } from "../../lib/seo/json-ld";
import { getDoc } from "../../lib/seo/live";
import { ClaimClient } from "./claim-client";

/**
 * `/claim`, finishing a transfer whose delivery failed. The form is a client component (it reads the
 * hash from the query string); the page around it is server-rendered, so the explanation is in the
 * HTML for search engines and assistants, and for anyone whose script has not loaded yet.
 */
export function generateMetadata() {
  return docMetadata("/claim");
}

export default async function ClaimPage() {
  const doc = await getDoc("/claim");
  return (
    <>
      <Suspense fallback={<ClaimIntro />}>
        <ClaimClient />
      </Suspense>
      <section
        aria-labelledby="claim-how"
        className="mx-auto w-full max-w-lg px-5 pb-4 text-[0.8125rem] leading-relaxed text-bone/45"
      >
        <h2 id="claim-how" className="text-sm font-semibold text-bone/80">
          How claiming works
        </h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 marker:text-bone/30">
          <li>Choose the chain the burn was made on and paste its transaction hash.</li>
          <li>The page asks Circle for the burn&rsquo;s attestation, which is public.</li>
          <li>
            Connect a wallet on the destination chain and submit the mint. You pay that
            chain&rsquo;s gas; the USDC goes to whoever the burn named.
          </li>
        </ol>
        <p className="mt-3">
          On Solana that is the transaction fee plus about 0.0007 SOL of permanent rent, and about
          0.0015 SOL more if the recipient&rsquo;s USDC account has to be opened first. If the page
          says &ldquo;already minted&rdquo;, Circle delivered it and there is nothing to claim.
        </p>
      </section>
      <SiteFooter wrapperContractId={env.cctpWrapperContractId} contractLabel="Stellar contract" />
      {doc && <JsonLd data={breadcrumbLd(doc)} />}
    </>
  );
}

/** What the server sends before the form's script runs: the same heading and introduction. */
function ClaimIntro() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-16 sm:px-5 sm:py-24">
      <header className="px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance]">
          Claim a transfer yourself
        </h1>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-bone/50">
          Circle&rsquo;s attestation for a burn is public, so anyone holding it can complete the
          mint — including you, and including transfers that are not yours. Use this when
          Circle&rsquo;s automatic delivery failed.
        </p>
      </header>
    </main>
  );
}
