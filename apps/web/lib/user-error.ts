import { formatError } from "./format-error";
import { type ClassifiedError, classifyWalletError } from "./wallet-error";

/**
 * What a person sees when something they started does not finish.
 *
 * Every failure on the site is written the same way, following NN/g's error-message guidelines and
 * the GOV.UK design system:
 *
 * 1. `title`: what happened, in a few plain words. Never "Error" or "Something went wrong" alone.
 * 2. `body`: one or two sentences on why, in the person's terms. No codes, no JSON, no stack.
 * 3. `steps`: what to do now, as instructions ("Open Freighter and unlock it."), in order.
 * 4. `funds`: where their money is. This is the question everyone has after a failed transfer,
 *    so it is always answered, and never more confidently than we know.
 * 5. `detail`: the raw text, kept out of sight behind "Technical details" with a copy button, so
 *    support can read it without anyone opening a browser console.
 *
 * Words we do not use: "invalid", "illegal", "oops", "sorry", "please", "console", "error code".
 * A cancel in the wallet is the person's choice, not a failure, so it is shown calmly (`info`).
 */
export interface UserError {
  tone: "info" | "alarm";
  title: string;
  body: string;
  steps: string[];
  /**
   * - `unmoved`: certain nothing left the wallet.
   * - `uncertain`: it may have gone out; check before sending again.
   * - `unless-shown`: nothing moved unless the page shows a transaction for it.
   * - `null`: the body already says it.
   */
  funds: "unmoved" | "uncertain" | "unless-shown" | null;
  /** A transaction to check, when we have one. */
  txHash?: string | undefined;
  /** The raw failure, for "Technical details". Empty when there is nothing more to show. */
  detail: string;
}

export interface ErrorContext {
  /** The wallet's name as the person knows it ("Freighter", "MetaMask"). */
  wallet?: string | undefined;
  /** The network the transfer runs on ("Stellar", "Base"). */
  chain?: string | undefined;
  /** The token that pays the network fee ("XLM", "ETH"). */
  feeToken?: string | undefined;
}

/** Where to ask for help. Shown with the copyable details on failures we cannot explain. */
export const SUPPORT_URL = "https://x.com/xebra_exchange";
export const SUPPORT_LABEL = "message us on X";

const ASK_FOR_HELP = "If it keeps happening, copy the technical details below and message us.";

/** The wallet could not be reached at all: missing, locked, or not allowed on this site. */
const NOT_CONNECTED = [
  /is not connected/i,
  /not connected/i,
  /not available/i,
  /not installed/i,
  /wallet not found/i,
  /no wallet/i,
  /is locked/i,
  /wallet locked/i,
];

/**
 * The bridge's own refusals (`describeRejectedTransaction`, `humanizeContractError` in
 * `lib/cctp-bridge.ts`). They contain "rejected", which the wallet classifier reads as a cancel, but
 * the network or contract refused these, not the person.
 */
const BRIDGE_REFUSALS = [
  /^The network rejected/i,
  /^The bridge rejected/i,
  /^The transfer was rejected by/i,
  /^Stellar rejected/i,
  /^Solana rejected/i,
];

/**
 * Text we can show as it is: one short sentence a person wrote, with no log, JSON, stack trace or
 * long hex in it. The app's own messages ("We could not get Circle's delivery fee just now…") pass;
 * a Soroban diagnostic log or a library's `TypeError` does not.
 */
export function isReadable(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 220) return false;
  if (t.includes("\n")) return false;
  if (/[{}[\]]/.test(t)) return false;
  if (/\b(TypeError|ReferenceError|SyntaxError|undefined|null|NaN)\b/.test(t)) return false;
  if (/\bError\(|HostError|at \S+ \(|0x[0-9a-f]{24,}/i.test(t)) return false;
  return true;
}

function walletName(ctx: ErrorContext): string {
  return ctx.wallet?.trim() || "your wallet";
}

/** Capitalises the first letter, for a wallet name that starts a title ("your wallet" → "Your wallet"). */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A transaction hash buried in a message, so the person can be pointed at it. */
function hashIn(err: unknown, raw: string): string | undefined {
  if (typeof err === "object" && err !== null && "txHash" in err) {
    const h = (err as { txHash: unknown }).txHash;
    if (typeof h === "string" && h.length > 0) return h;
  }
  return raw.match(/\b(0x[0-9a-fA-F]{64}|[0-9a-f]{64})\b/)?.[1];
}

/** The sentences `classifyWalletError` writes itself; anything else in `message` came from a form. */
const CLASSIFIER_WORDING = [
  /^You cancelled in your wallet/,
  /^Your wallet already has a request open/,
  /^Your wallet is on the wrong network/,
  /^Your wallet disconnected/,
  /^Your wallet has not authorized/,
  /^The request timed out/,
  /^A network error occurred/,
  /^Your wallet does not have enough/,
  /^The transaction failed on-chain/,
  /^An unexpected wallet error/,
];

/** A form's own explanation carried in a `ClassifiedError`, when it wrote one. */
function ownMessage(c: ClassifiedError): string | null {
  if (c.message === c.raw || !isReadable(c.message)) return null;
  return CLASSIFIER_WORDING.some((p) => p.test(c.message)) ? null : c.message;
}

/** Turns a classified wallet failure into the message a person sees. */
export function fromClassified(
  c: ClassifiedError,
  ctx: ErrorContext = {},
  txHash?: string,
): UserError {
  const wallet = walletName(ctx);
  const Wallet = sentence(wallet);
  const own = ownMessage(c);
  const detail = c.raw === own ? "" : c.raw;

  switch (c.kind) {
    case "declined":
    case "popup":
      return {
        tone: "info",
        title: `You cancelled in ${wallet}`,
        body: "Nothing was signed.",
        steps: ["Send again whenever you're ready."],
        funds: "unmoved",
        detail: "",
      };
    case "pending":
      return {
        tone: "alarm",
        title: `${Wallet} already has a request open`,
        body: `${Wallet} is still waiting on an earlier request, so it couldn't show this one.`,
        steps: [`Open ${wallet} and approve or reject the waiting request.`, "Send again."],
        funds: "unmoved",
        detail,
      };
    case "wrong_network":
      return {
        tone: "alarm",
        title: `${Wallet} is on the wrong network`,
        body: ctx.chain
          ? `This transfer runs on ${ctx.chain} Mainnet, and ${wallet} is set to a different network.`
          : `${Wallet} is set to a different network than this transfer uses.`,
        steps: [`Switch ${wallet} to ${ctx.chain ? `${ctx.chain} ` : ""}Mainnet.`, "Send again."],
        funds: "unmoved",
        detail,
      };
    case "funds":
      return {
        tone: "alarm",
        title: "Not enough in your wallet",
        body: `The wallet needs the USDC you're sending, plus a little ${ctx.feeToken ?? "of the network's own token"} to pay the network fee.`,
        steps: ["Add funds to the wallet, or send a smaller amount.", "Send again."],
        funds: "unmoved",
        detail,
      };
    case "onchain":
      return {
        tone: "alarm",
        title: "The network turned this transfer down",
        body:
          own ??
          (isReadable(c.raw)
            ? c.raw
            : "The network checked the transfer and refused it before anything moved."),
        steps: ["Wait a minute, then send again.", ASK_FOR_HELP],
        funds: "unmoved",
        detail,
      };
    case "network":
      return {
        tone: "alarm",
        title: "We lost the connection before it was confirmed",
        body:
          own ??
          "We couldn't hear back from the network, so we can't tell yet whether the transfer went out.",
        steps: [
          `Check the activity in ${wallet} for this transfer.`,
          "Send again only if it isn't there, so you don't pay twice.",
        ],
        funds: "uncertain",
        txHash,
        detail,
      };
    case "timeout":
      return {
        tone: "alarm",
        title: "We couldn't confirm the transfer in time",
        body:
          own ??
          "The network is taking longer than usual to answer, so the transfer may still go through.",
        steps: [
          `Check the activity in ${wallet} for this transfer.`,
          "Send again only if it isn't there, so you don't pay twice.",
        ],
        funds: "uncertain",
        txHash,
        detail,
      };
    default:
      return {
        tone: "alarm",
        title: "The transfer didn't go through",
        body:
          own ??
          (isReadable(c.raw) ? c.raw : "Something unexpected stopped it before it finished."),
        steps: ["Send again.", ASK_FOR_HELP],
        funds: "unless-shown",
        txHash,
        detail: own || !isReadable(c.raw) ? detail : "",
      };
  }
}

/**
 * The message for anything thrown while connecting, signing or sending. Reads the failure in this
 * order: the wallet could not be reached, a transaction that may have gone out, then whatever
 * `classifyWalletError` recognises.
 */
export function describeError(err: unknown, ctx: ErrorContext = {}): UserError {
  const raw = formatError(err);
  const wallet = walletName(ctx);
  const Wallet = sentence(wallet);
  const txHash = hashIn(err, raw);

  // Signed and handed over, but no answer came back: the one case where sending again could pay
  // twice. `UncertainSubmitError` (Stellar) and `EvmBurnUncertainError` (EVM) both mean this.
  if (
    err instanceof Error &&
    (err.name === "UncertainSubmitError" || (err as { mayHaveSent?: unknown }).mayHaveSent === true)
  ) {
    return {
      tone: "alarm",
      title: "We couldn't confirm the transfer was sent",
      body: "It was signed and handed to the network, but we lost touch before the network answered.",
      steps: [
        txHash
          ? "Check the transaction below before doing anything else."
          : `Check the activity in ${wallet} for this transfer.`,
        "Send again only if it never arrived, so you don't pay twice.",
      ],
      funds: "uncertain",
      txHash,
      detail: formatError((err as { cause?: unknown }).cause ?? err),
    };
  }

  if (NOT_CONNECTED.some((p) => p.test(raw))) {
    return {
      tone: "alarm",
      title: `${Wallet} isn't connected`,
      body: `We couldn't reach ${wallet}, so nothing was signed.`,
      steps: [
        `Open ${wallet} and unlock it.`,
        `If ${wallet} asks, allow this site to connect.`,
        "Send again.",
      ],
      funds: "unmoved",
      detail: raw,
    };
  }

  if (BRIDGE_REFUSALS.some((p) => p.test(raw))) {
    return fromClassified({ kind: "onchain", message: raw, maybeSent: false, raw }, ctx, txHash);
  }

  return fromClassified(classifyWalletError(err), ctx, txHash);
}

/**
 * One of the app's own sentences ("We could not get Circle's delivery fee just now, so nothing was
 * sent."), shown under a plain title. These are written for people already, and say themselves
 * whether anything moved.
 */
export function messageError(
  text: string,
  opts: { title?: string; steps?: string[] } = {},
): UserError {
  return {
    tone: "alarm",
    title: opts.title ?? "The transfer wasn't sent",
    body: text,
    steps: opts.steps ?? [],
    funds: /nothing was sent|nothing has moved|no usdc has moved|nothing moved/i.test(text)
      ? null
      : "unmoved",
    detail: "",
  };
}
