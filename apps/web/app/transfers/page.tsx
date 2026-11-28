import Link from "next/link";
import { CHAIN_NAMES } from "../../components/bridge/chain-glyph";
import { SiteFooter } from "../../components/site/site-footer";
import { ContentHeader } from "../../components/site/site-nav";
import { env } from "../../lib/env";
import { pageMetadata } from "../../lib/site";
import {
  type RecordedTransfer,
  TRANSFERS_RECORD_URL,
  loadTransfersRecord,
} from "../../lib/transfers-record";

// The record is rewritten through the day; read it again every ten minutes.
export const revalidate = 600;

export const metadata = pageMetadata({
  title: "Transfers",
  description:
    "Every Xebra transfer we can prove on chain, read from the chains. Each row links to its transactions on the chains' own explorers.",
  path: "/transfers",
});

const SOURCE_CODE =
  "https://github.com/xebra-org/xebra/blob/main/apps/web/scripts/transfers-record.mjs";
const RECORD_HISTORY = "https://github.com/xebra-org/xebra/commits/proof-data";

const chainName = (id: string | null) =>
  id === null ? null : ((CHAIN_NAMES as Record<string, string>)[id] ?? id);

const usdc = (n: number | null) =>
  n === null
    ? null
    : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });

function proofLabel(t: RecordedTransfer): string {
  if (t.proof === "contract") return "Xebra's contract";
  if (t.proof === "fee-in-burn") return "Fee in the same transaction";
  if (t.proof === "relayed") return "Delivered by Xebra";
  if (t.proof === "listed") return "Early transfer";
  return t.tagged ? "Tagged fee payment" : "Fee payment";
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

const short = (tx: string) => (tx.length > 14 ? `${tx.slice(0, 6)}...${tx.slice(-6)}` : tx);

export default async function Page() {
  const result = await loadTransfersRecord();
  const totals = result.ok ? result.record.totals : null;
  return (
    <>
      <ContentHeader current="/transfers" />
      <main id="content" className="mx-auto w-full max-w-4xl px-4 pt-14 sm:px-5 sm:pt-20">
        <h1 className="text-3xl font-semibold tracking-tight text-balance text-bone sm:text-4xl">
          {totals && totals.transfers > 0
            ? `${count(totals.transfers, "transfer", "transfers")} across ${count(totals.chains, "chain", "chains")}`
            : "Xebra transfers, on chain"}
        </h1>
        <p className="mt-4 max-w-[60ch] text-[0.9375rem] leading-relaxed text-pretty text-bone/60">
          Every transfer made with Xebra that we can prove on chain, including the team&rsquo;s own.
          Each row opens on the chain&rsquo;s own explorer. The list is read from the chains, not
          from our servers.
        </p>

        {!result.ok ? (
          <div className="mt-12 border border-bone/15 p-5 text-sm leading-relaxed text-bone/70">
            The record could not be read just now. It is public:{" "}
            <a href={TRANSFERS_RECORD_URL} className="text-signal underline underline-offset-2">
              open the file
            </a>{" "}
            or try again in a few minutes.
          </div>
        ) : (
          <>
            <dl className="mt-12 grid grid-cols-2 gap-6 border-y border-bone/10 py-6 sm:grid-cols-4">
              <Stat
                label="Transfers"
                value={result.record.totals.transfers.toLocaleString("en-US")}
              />
              <Stat label="USDC moved" value={usdc(result.record.totals.usdcSent) ?? "0"} />
              <Stat label="Chains" value={result.record.totals.chains.toLocaleString("en-US")} />
              <Stat label="Routes" value={result.record.totals.routes.toLocaleString("en-US")} />
            </dl>

            {result.record.transfers.length === 0 ? (
              <p className="mt-10 text-sm text-bone/60">
                No transfers recorded yet. A transfer shows up here within the hour after it lands.
              </p>
            ) : (
              <TransferList transfers={result.record.transfers} />
            )}

            {Object.entries(result.record.contracts)
              .filter(([, c]) => c.counted > c.listed)
              .map(([chain, c]) => (
                <p key={chain} className="mt-6 max-w-[65ch] text-xs leading-relaxed text-bone/50">
                  Xebra&rsquo;s {chainName(chain) ?? chain} contracts have counted{" "}
                  {count(c.counted, "transfer", "transfers")}; {c.listed}{" "}
                  {c.listed === 1 ? "is" : "are"} listed here.{" "}
                  {c.counted - c.listed === 1
                    ? "The other one was sent from a wallet this list cannot look up yet."
                    : `The other ${c.counted - c.listed} were sent from wallets this list cannot look up yet.`}
                </p>
              ))}
            {Object.keys(result.record.contracts).length === 0 &&
              Object.entries(result.record.coverage).map(([source, since]) => (
                <p key={source} className="mt-6 text-xs text-bone/50">
                  {chainName(source) ?? source} transfers before {when(since)} UTC are not in this
                  list yet.
                </p>
              ))}
            <p className="mt-2 text-xs text-bone/40">
              Last read from the chains {when(result.record.updatedAt)} UTC.
            </p>
          </>
        )}

        <section className="mt-16 max-w-[65ch] space-y-3 text-sm leading-relaxed text-bone/60">
          <h2 className="text-base font-medium text-bone">How a row proves it was Xebra</h2>
          <p>
            <span className="text-bone">Xebra&rsquo;s contract:</span> from Stellar and Arc, the
            transfer goes through Xebra&rsquo;s own contract, which records it.
          </p>
          <p>
            <span className="text-bone">Fee in the same transaction:</span> from Solana and Sui,
            Circle&rsquo;s burn and Xebra&rsquo;s fee are one transaction. Solana&rsquo;s also
            carries the note <code className="font-mono text-bone/80">xebra</code>.
          </p>
          <p>
            <span className="text-bone">Tagged fee payment:</span> from other EVM chains, the fee is
            paid in its own transaction marked with Xebra&rsquo;s code. A sender who declines that
            payment does not appear here.
          </p>
          <p>
            <span className="text-bone">Delivered by Xebra:</span> into Stellar, Xebra&rsquo;s own
            account signed the transaction that delivered the USDC. The row links the send and the
            delivery.
          </p>
          <p>
            <span className="text-bone">Early transfer:</span> sent before the route had a Xebra
            contract or fee. Circle&rsquo;s own record confirms it, and the row links the send and
            the delivery so you can check both.
          </p>
          <p>
            The list is written by{" "}
            <a href={SOURCE_CODE} className="text-signal underline underline-offset-2">
              open source code
            </a>{" "}
            and every update is kept in{" "}
            <a href={RECORD_HISTORY} className="text-signal underline underline-offset-2">
              public history
            </a>
            . Fees are explained on{" "}
            <Link href="/fees" className="text-signal underline underline-offset-2">
              fees
            </Link>
            .
          </p>
        </section>
      </main>
      <SiteFooter
        wrapperContractId={env.cctpWrapperContractId}
        contractLabel="Stellar contract"
        wide
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-bone/45">{label}</dt>
      <dd className="mt-1 font-mono text-2xl tabular-nums text-bone">{value}</dd>
    </div>
  );
}

function TransferList({ transfers }: { transfers: RecordedTransfer[] }) {
  return (
    <div className="mt-10">
      {/* Wide screens: a table. */}
      <table className="hidden w-full text-left text-sm md:table">
        <thead>
          <tr className="text-xs text-bone/45">
            <th className="pb-3 font-normal">When (UTC)</th>
            <th className="pb-3 font-normal">Route</th>
            <th className="pb-3 text-right font-normal">Sent</th>
            <th className="pb-3 text-right font-normal">Xebra fee</th>
            <th className="pb-3 pl-6 font-normal">Proof</th>
            <th className="pb-3 font-normal">Transactions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bone/[0.07]">
          {transfers.map((t) => (
            <tr key={t.id} className="text-bone/80">
              <td className="py-3 pr-4 whitespace-nowrap text-bone/60">{when(t.at)}</td>
              <td className="py-3 pr-4">{route(t)}</td>
              <td className="py-3 text-right font-mono tabular-nums">{usdc(t.amount) ?? "-"}</td>
              <td className="py-3 text-right font-mono tabular-nums">{usdc(t.xebraFee) ?? "-"}</td>
              <td className="py-3 pl-6 text-bone/60">{proofLabel(t)}</td>
              <td className="py-3 whitespace-nowrap">
                <TxLinks t={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phones: one block per transfer. */}
      <ul className="space-y-6 md:hidden">
        {transfers.map((t) => (
          <li key={t.id} className="border-l border-bone/15 pl-4 text-sm">
            <p className="text-bone">{route(t)}</p>
            <p className="mt-1 font-mono tabular-nums text-bone/80">
              {usdc(t.amount) ? `${usdc(t.amount)} USDC` : "Amount not on chain"}
              {usdc(t.xebraFee) ? `, fee ${usdc(t.xebraFee)}` : ""}
            </p>
            <p className="mt-1 text-xs text-bone/50">
              {when(t.at)} UTC. {proofLabel(t)}.
            </p>
            <p className="mt-1">
              <TxLinks t={t} />
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function route(t: RecordedTransfer): string {
  const from = chainName(t.source) ?? t.source;
  const to = chainName(t.to);
  return to ? `${from} to ${to}` : `From ${from}`;
}

const LINK =
  "font-mono text-xs text-signal underline underline-offset-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-signal";

/** The send, and the delivery when the record has it. */
function TxLinks({ t }: { t: RecordedTransfer }) {
  return (
    <>
      <a href={t.sourceTxUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
        {short(t.sourceTx)}
      </a>
      {t.deliveryTx && t.deliveryTxUrl ? (
        <>
          <span className="px-1.5 text-xs text-bone/35">then</span>
          <a href={t.deliveryTxUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            {short(t.deliveryTx)}
          </a>
        </>
      ) : null}
    </>
  );
}
