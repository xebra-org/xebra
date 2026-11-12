import { type Operation, StrKey, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { submitSigned } from "../../../../lib/cctp-bridge";
import { env } from "../../../../lib/env";

/**
 * Submits a Stellar transaction the user's wallet has already signed.
 *
 * The page used to send it to Stellar's RPC from the browser, and a flaky connection there left a
 * signed transfer unsent ("Network Error"). The server's connection is steadier, and it retries:
 * resending a signed transaction is safe, because the network accepts one transaction per hash
 * (a resend answers DUPLICATE with the same hash) and nothing in it can be changed.
 *
 * Only a transaction that calls Xebra's Stellar contract is accepted, so this is not an open
 * relay for arbitrary transactions.
 */
export const dynamic = "force-dynamic";

const ATTEMPTS = 3;

export async function POST(req: Request): Promise<Response> {
  const wrapper = env.cctpWrapperContractId;
  if (!wrapper)
    return Response.json({ error: "The bridge contract is not configured." }, { status: 503 });

  let xdr: unknown;
  try {
    ({ xdr } = (await req.json()) as { xdr?: unknown });
  } catch {
    return Response.json({ error: "Send JSON with the signed xdr." }, { status: 400 });
  }
  if (typeof xdr !== "string" || xdr.length > 20_000) {
    return Response.json({ error: "Send JSON with the signed xdr." }, { status: 400 });
  }

  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(xdr, env.stellarNetworkPassphrase);
  } catch {
    return Response.json(
      { error: "That is not a Stellar transaction for this network." },
      { status: 400 },
    );
  }
  const ops = "operations" in tx ? tx.operations : [];
  const wrapperHex = Buffer.from(StrKey.decodeContract(wrapper)).toString("hex");
  let callsWrapper = false;
  if (ops.length === 1 && ops[0]?.type === "invokeHostFunction") {
    try {
      const fn = (ops[0] as Operation.InvokeHostFunction).func;
      callsWrapper =
        fn.switch().name === "hostFunctionTypeInvokeContract" &&
        Buffer.from(
          fn.invokeContract().contractAddress().contractId() as unknown as Uint8Array,
        ).toString("hex") === wrapperHex;
    } catch {
      callsWrapper = false;
    }
  }
  if (!callsWrapper) {
    return Response.json(
      { error: "Only transfers through Xebra's contract are submitted here." },
      { status: 400 },
    );
  }

  const server = new rpc.Server(env.sorobanRpcUrl);
  let last: unknown = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const { txHash } = await submitSigned(server, tx, "transfer");
      return Response.json({ txHash });
    } catch (err) {
      last = err;
      // A refusal from the network (bad sequence, expired, insufficient fee) will not change on a
      // resend; only a failure to reach the network is worth another try.
      const message = err instanceof Error ? err.message : String(err);
      if (
        !/network error|timeout|ECONN|ETIMEDOUT|ENETUNREACH|socket|fetch failed|TRY_AGAIN_LATER/i.test(
          message,
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return Response.json(
    { error: last instanceof Error ? last.message : "Stellar's network could not be reached." },
    { status: 502 },
  );
}
