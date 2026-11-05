import { notFound } from "next/navigation";
import { SiteFooter } from "../../components/site/site-footer";
import { ContentHeader } from "../../components/site/site-nav";
import { env } from "../../lib/env";
import { formatUsdc } from "../../lib/sui-stellar/cctp";
import { maxUsdcBase, relayerSecret, suiStellarEnabled } from "../../lib/sui-stellar/config";
import { SuiClient } from "./sui-client";

// Read at request time: the switch, the cap and the relayer are Vercel env values, not build inputs.
export const dynamic = "force-dynamic";

export default function SuiPage() {
  if (!suiStellarEnabled()) notFound();
  return (
    <>
      <ContentHeader current="/sui" />
      <SuiClient maxUsdc={formatUsdc(maxUsdcBase())} relayerEnabled={relayerSecret() !== null} />
      <SiteFooter wrapperContractId={env.cctpWrapperContractId} contractLabel="Stellar contract" />
    </>
  );
}
