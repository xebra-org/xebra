import type { Metadata } from "next";
import { SiteFooter } from "../../components/site/site-footer";
import { ContentHeader } from "../../components/site/site-nav";
import { env } from "../../lib/env";
import { NearIntentsClient } from "./near-intents-client";

export const metadata: Metadata = {
  title: "USDC into NEAR Intents from Stellar, Arc and more",
  description:
    "Swap USDC on Stellar, Arc and other Circle chains NEAR Intents does not reach into anything it delivers. Xebra carries the USDC over Circle's CCTP into the NEAR Intents deposit address; you sign on your own chain.",
};

export default function NearIntentsPage() {
  return (
    <>
      <ContentHeader current="/near-intents" />
      <NearIntentsClient />
      <SiteFooter wrapperContractId={env.cctpWrapperContractId} contractLabel="Stellar contract" />
    </>
  );
}
