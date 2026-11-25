import {
  AlreadyMintedError,
  SUI_ADDRESS,
  SuiCctpPausedError,
  WrongSuiCallerError,
  buildSuiMint,
  readSuiBoundMessage,
} from "@xebra/sdk/build";
import { formatUsdc6 } from "@xebra/sdk/core";
import { suiClient } from "../../../../lib/sui-stellar/client";

/**
 * Builds the Sui mint for a transfer bound for Sui, for the connected wallet to sign. Nothing is
 * signed or sent here.
 *
 * Circle does not deliver to Sui, so every transfer into Sui ends with somebody submitting Circle's
 * attested message there: the recipient, or anyone willing to pay the gas for them. The USDC goes to
 * the address the burn named, whoever signs. Built here rather than in the browser only because the
 * browser has no Sui node of its own; the server reads the chain once to resolve the shared objects
 * and to run the mint without executing it, so a transfer that was already minted is reported
 * instead of handed to the wallet to fail.
 *
 * Open to anyone, like `/api/attestation`: the message and attestation are public, and the only
 * thing the result can do is deliver USDC to the recipient Circle signed for.
 */
export const dynamic = "force-dynamic";

const HEX = /^0x[0-9a-fA-F]+$/;
/** A V2 burn message is 376 bytes plus its hook; a Sui-bound one carries no hook worth 4 KB. */
const MAX_MESSAGE_HEX = 2 + 2 * 4096;
/** Circle signs with 65-byte signatures; a handful at most. */
const MAX_ATTESTATION_HEX = 2 + 2 * 65 * 8;

export async function POST(request: Request): Promise<Response> {
  let body: { sender?: unknown; message?: unknown; attestation?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Send JSON with sender, message and attestation." },
      { status: 400 },
    );
  }
  const sender = typeof body.sender === "string" ? body.sender.trim().toLowerCase() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const attestation = typeof body.attestation === "string" ? body.attestation.trim() : "";
  if (!SUI_ADDRESS.test(sender)) {
    return Response.json(
      { error: "sender must be a Sui address (0x and 64 hex)" },
      { status: 400 },
    );
  }
  if (!HEX.test(message) || message.length % 2 !== 0 || message.length > MAX_MESSAGE_HEX) {
    return Response.json({ error: "message must be Circle's message, as hex" }, { status: 400 });
  }
  if (
    !HEX.test(attestation) ||
    attestation.length % 2 !== 0 ||
    attestation.length > MAX_ATTESTATION_HEX
  ) {
    return Response.json(
      { error: "attestation must be Circle's attestation, as hex" },
      { status: 400 },
    );
  }

  // Refuse a message for another chain before asking the node anything.
  try {
    readSuiBoundMessage(Uint8Array.from(Buffer.from(message.slice(2), "hex")));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "not a transfer to Sui" },
      { status: 400 },
    );
  }

  try {
    const built = await buildSuiMint(suiClient(), { sender, message, attestation });
    return Response.json({
      status: "ready",
      transaction: built.transaction,
      recipient: built.message.recipient,
      // Strings: 6-decimal base units are not safe JSON numbers everywhere.
      received: built.message.received.toString(),
      receivedUsdc: formatUsdc6(built.message.received),
    });
  } catch (err) {
    if (err instanceof AlreadyMintedError) return Response.json({ status: "already-minted" });
    if (err instanceof SuiCctpPausedError) {
      return Response.json({ status: "paused", error: err.message }, { status: 503 });
    }
    if (err instanceof WrongSuiCallerError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    console.error("sui-mint build failed", err);
    return Response.json(
      { error: "Could not prepare the Sui transaction just now. Try again in a moment." },
      { status: 502 },
    );
  }
}
