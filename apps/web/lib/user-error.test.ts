import { describe, expect, it } from "vitest";
import { describeError, fromClassified, isReadable, messageError } from "./user-error";

const STELLAR = { wallet: "Freighter", chain: "Stellar", feeToken: "XLM" };

/** Nothing a person reads should send them to developer tools or use words we avoid. */
function expectPlain(e: { title: string; body: string; steps: string[] }) {
  const text = [e.title, e.body, ...e.steps].join(" ");
  expect(text).not.toMatch(/console|\[xebra\]|invalid|oops|sorry|please/i);
}

describe("describeError", () => {
  it("tells someone whose Freighter is not connected what to do, and that nothing moved", () => {
    const e = describeError(new Error("Freighter is not connected"), STELLAR);
    expect(e.title).toBe("Freighter isn't connected");
    expect(e.body).toMatch(/nothing was signed/i);
    expect(e.steps[0]).toBe("Open Freighter and unlock it.");
    expect(e.steps).toContain("Send again.");
    expect(e.funds).toBe("unmoved");
    expect(e.detail).toBe("Freighter is not connected");
    expectPlain(e);
  });

  it("reads a wallet kit's plain-object rejection too", () => {
    const e = describeError({ error: { code: -1, message: "Wallet is locked" } }, STELLAR);
    expect(e.title).toBe("Freighter isn't connected");
  });

  it("shows a cancel calmly, as the person's choice", () => {
    const e = describeError({ code: 4001, message: "User rejected the request." }, STELLAR);
    expect(e.tone).toBe("info");
    expect(e.title).toBe("You cancelled in Freighter");
    expect(e.detail).toBe("");
    expectPlain(e);
  });

  it("never says nothing moved when a signed transaction may have gone out", () => {
    const hash = "a".repeat(64);
    const err = Object.assign(new Error(`Submitting the burn failed. Check transaction ${hash}`), {
      name: "UncertainSubmitError",
      txHash: hash,
    });
    const e = describeError(err, STELLAR);
    expect(e.funds).toBe("uncertain");
    expect(e.txHash).toBe(hash);
    expect(e.steps.join(" ")).toMatch(/only if it never arrived/i);
    expectPlain(e);
  });

  it("treats an EVM burn the wallet may have broadcast the same way", () => {
    const err = Object.assign(new Error("connection dropped"), { mayHaveSent: true });
    const e = describeError(err, { wallet: "MetaMask", chain: "Base" });
    expect(e.funds).toBe("uncertain");
    expect(e.steps[0]).toBe("Check the activity in MetaMask for this transfer.");
  });

  it("names the fee token when the wallet is short", () => {
    const e = describeError(new Error("txInsufficientBalance"), STELLAR);
    expect(e.title).toBe("Not enough in your wallet");
    expect(e.body).toMatch(/XLM/);
  });

  it("keeps a Soroban diagnostic log out of the message and in the details", () => {
    const log =
      'HostError: Error(Contract, #7)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CCPV…, topics:[error, Error(Contract, #7)], data:"escalating error to panic"';
    const e = describeError(new Error(log), STELLAR);
    expect(e.body).not.toContain("HostError");
    expect(e.detail).toContain("Error(Contract, #7)");
    expectPlain(e);
  });

  it("shows one of the app's own readable sentences as the body", () => {
    const text = "The bridge rejected this transfer (code 7). Nothing was sent.";
    const e = describeError(new Error(text), STELLAR);
    expect(e.body).toBe(text);
  });

  it("says 'your wallet' when the wallet's name is not known", () => {
    const e = describeError(new Error("not installed"));
    expect(e.title).toBe("Your wallet isn't connected");
    expect(e.steps[0]).toBe("Open your wallet and unlock it.");
  });
});

describe("fromClassified", () => {
  it("prefers a form's own explanation over the classifier's generic sentence", () => {
    const e = fromClassified(
      {
        kind: "timeout",
        message: "Solana did not confirm the burn within 90 seconds. It may still land.",
        maybeSent: true,
        raw: "TransactionExpiredTimeoutError: ...",
      },
      { wallet: "Phantom", chain: "Solana" },
    );
    expect(e.body).toBe("Solana did not confirm the burn within 90 seconds. It may still land.");
    expect(e.funds).toBe("uncertain");
  });

  it("uses its own wording over the classifier's", () => {
    const e = fromClassified({
      kind: "network",
      message: "A network error occurred while communicating with the network.",
      maybeSent: true,
      raw: "fetch failed",
    });
    expect(e.body).not.toMatch(/A network error occurred/);
  });
});

describe("messageError", () => {
  it("does not repeat 'nothing was sent' when the sentence already says it", () => {
    const e = messageError(
      "We could not get Circle's delivery fee just now, so nothing was sent.",
      {
        title: "We couldn't get the delivery fee",
      },
    );
    expect(e.funds).toBeNull();
    expect(e.title).toBe("We couldn't get the delivery fee");
  });
});

describe("isReadable", () => {
  it.each([
    ["Freighter is not connected", true],
    ['{"code":-32603}', false],
    ["TypeError: Cannot read properties of undefined", false],
    ["line one\nline two", false],
    [`0x${"ab".repeat(32)} reverted`, false],
  ])("%s → %s", (text, ok) => {
    expect(isReadable(text)).toBe(ok);
  });
});
