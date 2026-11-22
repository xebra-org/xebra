import { PublicKey } from "@solana/web3.js";
import { env } from "../../../lib/env";

/**
 * Resolves a Solana wallet address to the USDC token account CCTP must mint into, and reports
 * whether that account exists.
 *
 * # Why this is server-side
 *
 * Solana's public RPC **blocks browser requests**. It answers the CORS preflight with 200 and
 * then returns **403 on the actual POST** whenever an `Origin` header is present. The browser
 * therefore cannot query account state directly.
 *
 * The client used to do this itself, and its error handling turned a failed request into
 * `exists: false` — so a wallet that plainly held USDC was reported as having no token
 * account, blocking a valid transfer. The check now runs here, where there is no `Origin`
 * header and no CORS involved.
 *
 * Soroban RPC, Horizon and Circle's Iris all permit browser origins, which is why only Solana's
 * calls needed moving: this one, and the claim page's, through `/api/solana-rpc`.
 *
 * # Why `unknown` is a distinct answer
 *
 * "The account does not exist" and "I could not find out" have different consequences. The
 * first is a price: Circle's Forwarding Service opens the account during delivery, for a higher
 * fee the burn has to carry. The second cannot be priced either way, so the form holds the
 * transfer until a lookup succeeds rather than guess. They are reported separately and the UI
 * treats them differently.
 */

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const owner = new URL(request.url).searchParams.get("owner")?.trim();
  if (!owner) {
    return Response.json({ error: "owner query parameter is required" }, { status: 400 });
  }

  let ownerKey: PublicKey;
  try {
    ownerKey = new PublicKey(owner);
  } catch {
    return Response.json({ error: "not a valid Solana address" }, { status: 400 });
  }

  const mint = new PublicKey(env.usdcSolanaMint);
  const [tokenAccount] = PublicKey.findProgramAddressSync(
    [ownerKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );

  try {
    const res = await fetch(env.solanaRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [tokenAccount.toBase58(), { encoding: "base64" }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    if (!res.ok) {
      return Response.json({
        tokenAccount: tokenAccount.toBase58(),
        status: "unknown",
        reason: `RPC returned ${res.status}`,
      });
    }

    const body = (await res.json()) as {
      result?: { value: { owner: string } | null };
      error?: { message?: string };
    };

    if (body.error) {
      console.error("Solana RPC lookup failed", body.error);
      return Response.json({
        tokenAccount: tokenAccount.toBase58(),
        status: "unknown",
        reason: "Solana RPC returned an error",
      });
    }

    const value = body.result?.value ?? null;
    if (value === null) {
      return Response.json({ tokenAccount: tokenAccount.toBase58(), status: "missing" });
    }
    if (value.owner !== TOKEN_PROGRAM.toBase58()) {
      return Response.json({
        tokenAccount: tokenAccount.toBase58(),
        status: "missing",
        reason: "address exists but is not an SPL token account",
      });
    }

    return Response.json({ tokenAccount: tokenAccount.toBase58(), status: "exists" });
  } catch (err) {
    console.error("Solana RPC lookup failed", err);
    return Response.json({
      tokenAccount: tokenAccount.toBase58(),
      status: "unknown",
      reason: "Solana RPC lookup failed",
    });
  }
}
