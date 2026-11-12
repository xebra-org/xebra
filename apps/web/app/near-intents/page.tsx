import type { Metadata } from "next";
import { SiteFooter } from "../../components/site/site-footer";
import { ContentHeader } from "../../components/site/site-nav";
import { env } from "../../lib/env";
import { NearIntentsClient } from "./near-intents-client";

export const metadata: Metadata = {
  title: "Stellar USDC into NEAR Intents",
  description:
    "Swap USDC on Stellar into anything NEAR Intents delivers. Xebra carries the USDC over Circle's CCTP into the NEAR Intents deposit address; one signature on Stellar.",
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
