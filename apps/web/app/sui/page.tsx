import { formatUsdcAmount } from "@xebra/sdk/core";
import { notFound } from "next/navigation";
import { SiteFooter } from "../../components/site/site-footer";
import { ContentHeader } from "../../components/site/site-nav";
import { env } from "../../lib/env";
import {
  maxUsdcBase,
  relayerSecret,
  suiEvmDestinations,
  suiStellarEnabled,
} from "../../lib/sui-stellar/config";
import { SuiClient } from "./sui-client";

// Read at request time: the switch, the cap and the relayer are Vercel env values, not build inputs.
export const dynamic = "force-dynamic";

export default function SuiPage() {
  if (!suiStellarEnabled()) notFound();
  const cap = maxUsdcBase();
  return (
    <>
      <ContentHeader current="/sui" />
      <SuiClient
        maxUsdc={cap === null ? null : formatUsdcAmount(cap)}
        relayerEnabled={relayerSecret() !== null}
        evmDestinations={suiEvmDestinations().map((c) => c.id)}
      />
      <SiteFooter wrapperContractId={env.cctpWrapperContractId} contractLabel="Stellar contract" />
    </>
  );
}
