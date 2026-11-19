import { formatError } from "./format-error";

export type WalletErrorKind =
  | "declined"
  | "popup"
  | "pending"
  | "wrong_network"
  | "funds"
  | "onchain"
  | "network"
  | "timeout"
  | "unknown";

export interface ClassifiedError {
  kind: WalletErrorKind;
  /** One plain sentence a non-developer understands. No stack, no Java, no JSON. */
  message: string;
  /** network/timeout: the transaction may have gone out, check the chain before retrying. */
  maybeSent: boolean;
  /** The original text, for logs only. */
  raw: string;
}

function extractCode(err: unknown): number | null {
  if (typeof err === "object" && err !== null) {
    if ("code" in err && typeof (err as { code: unknown }).code === "number") {
      return (err as { code: number }).code;
    }
    if ("cause" in err) {
      const c = extractCode((err as { cause: unknown }).cause);
      if (c !== null) return c;
    }
    if ("error" in err && typeof (err as { error: unknown }).error === "object") {
      const c = extractCode((err as { error: unknown }).error);
      if (c !== null) return c;
    }
  }
  return null;
}

const NETWORK_PATTERNS = [
  /java\.net\.UnknownHostException/i,
  /No address associated with hostname/i,
  /fetch failed/i,
  /failed to fetch/i,
  /connection closed/i,
  /connection reset/i,
  /socket hang up/i,
  /network error/i,
  /networkrequestfailed/i,
  /net::err/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /offline/i,
];

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /request timed out/i,
  /transaction expired/i,
  /blockhash.*(expired|not found)/i,
];

const FUNDS_PATTERNS = [
  /insufficient funds/i,
  /insufficient balance/i,
  /txInsufficientBalance/i,
  /InsufficientFundsForFee/i,
  /not enough gas/i,
  /exceeds balance/i,
];

const ONCHAIN_PATTERNS = [
  /execution reverted/i,
  /\brevert\b/i,
  /Move abort/i,
  /InstructionError/i,
  /simulation failed/i,
  /failed simulation/i,
  /rejected transaction/i,
];

const POPUP_PATTERNS = [
  /popup.*(closed|blocked)/i,
  /window.*(closed|blocked)/i,
  /pop-up.*(closed|blocked)/i,
  /blocked pop/i,
  /user closed popup/i,
];

const DECLINED_PATTERNS = [
  /user rejected/i,
  /user denied/i,
  /user cancelled/i,
  /user declined/i,
  /user disapproved/i,
  /transaction rejected/i,
  /rejected by user/i,
  /\bdeclined\b/i,
  /\brejected\b/i,
  /\bcancelled\b/i,
  /\bcanceled\b/i,
  /\bdenied\b/i,
];

/**
 * Classifies an unknown error thrown during wallet interactions into a user-friendly format.
 */
export function classifyWalletError(err: unknown): ClassifiedError {
  const raw = formatError(err);
  const code = extractCode(err);

  // EIP-1193 codes take precedence when present
  if (code === 4001 || code === 5000) {
    return {
      kind: "declined",
      message: "You cancelled in your wallet. Nothing was sent.",
      maybeSent: false,
      raw,
    };
  }

  if (code === -32002) {
    return {
      kind: "pending",
      message:
        "Your wallet already has a request open. Finish or dismiss it there, then try again.",
      maybeSent: false,
      raw,
    };
  }

  if (code === 4902) {
    return {
      kind: "wrong_network",
      message: "Your wallet is on the wrong network. Switch networks in your wallet and try again.",
      maybeSent: false,
      raw,
    };
  }

  if (code === 4900 || code === 4901) {
    return {
      kind: "network",
      message:
        "Your wallet disconnected from the network. Check your wallet's activity before retrying.",
      maybeSent: true,
      raw,
    };
  }

  if (code === 4100) {
    return {
      kind: "declined",
      message: "Your wallet has not authorized this account. Check permissions in your wallet.",
      maybeSent: false,
      raw,
    };
  }

  // 1. Check network and timeout BEFORE declined (e.g. "connection closed" is network, not decline)
  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        kind: "timeout",
        message: "The request timed out. Check your wallet's activity before retrying.",
        maybeSent: true,
        raw,
      };
    }
  }

  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        kind: "network",
        message:
          "A network error occurred while communicating with the network. Check your wallet's activity before retrying.",
        maybeSent: true,
        raw,
      };
    }
  }

  // 2. Funds
  for (const pattern of FUNDS_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        kind: "funds",
        message: "Your wallet does not have enough funds or gas to complete this transfer.",
        maybeSent: false,
        raw,
      };
    }
  }

  // 3. On-chain failures
  for (const pattern of ONCHAIN_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        kind: "onchain",
        message: "The transaction failed on-chain. Nothing was sent.",
        maybeSent: false,
        raw,
      };
    }
  }

  // 4. Popups
  for (const pattern of POPUP_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        kind: "popup",
        message: "You cancelled in your wallet. Nothing was sent.",
        maybeSent: false,
        raw,
      };
    }
  }

  // 5. Declined
  for (const pattern of DECLINED_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        kind: "declined",
        message: "You cancelled in your wallet. Nothing was sent.",
        maybeSent: false,
        raw,
      };
    }
  }

  // Fallback
  return {
    kind: "unknown",
    message:
      raw && raw.length < 150 ? raw : "An unexpected wallet error occurred. Please try again.",
    maybeSent: false,
    raw,
  };
}
