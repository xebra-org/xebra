import { FEES } from "./facts";

export interface Faq {
  q: string;
  /** Markdown. */
  a: string;
}

/**
 * The questions people ask before moving money, answered as the bridge actually behaves.
 * `arcViaWrapper`: whether transfers out of Arc go through Xebra's contract (and pay its fee).
 */
export function faqFor(arcViaWrapper: boolean): Faq[] {
  const arcFeeSentence = arcViaWrapper
    ? `From Arc the same rule applies, through Xebra's contract on Arc, plus a fraction of a cent of Arc gas, which Arc charges in USDC.`
    : `From Arc there is no Xebra fee: you pay Circle's delivery fee, usually a few cents, plus a fraction of a cent of Arc gas, which Arc charges in USDC.`;

  return [
    {
      q: "Is the USDC I receive wrapped or bridged?",
      a: "No. Xebra uses Circle's Cross-Chain Transfer Protocol (CCTP): Circle burns your USDC on the chain you send from and mints the same amount of native USDC, issued by Circle, on the chain you send to. There is no wrapped token, no liquidity pool and no IOU.",
    },
    {
      q: "What does a transfer cost?",
      a: `From Stellar, Xebra's fee is ${FEES.bps / 100}% of the amount, at least ${FEES.minFeeUsdc} USDC, and Circle's delivery fee is paid out of it rather than added on top. The Stellar network fee is a fraction of a cent in XLM. ${arcFeeSentence} The bridge shows exactly what the recipient will get before you sign. See [fees](/fees).`,
    },
    {
      q: "How long does a transfer take?",
      a: "Usually a few minutes. Circle attests the burn once the chain you send from has finalised it, and its Forwarding Service then mints on the destination and pays the gas there.",
    },
    {
      q: "What happens if my transfer does not arrive?",
      a: "It is not lost. Every burn is attested by Circle and can be minted on the destination by anyone, so you can finish it yourself: open [claim](/claim), paste the burn's transaction hash, and submit the mint from your own wallet. You pay that chain's gas, a cent or so.",
    },
    {
      q: "Does Xebra hold my funds?",
      a: arcViaWrapper
        ? "Not between transactions. From Stellar your USDC moves from your wallet to Circle inside the one transaction you sign. From Arc, Circle's contract burns from whoever calls it, so Xebra's contract holds the USDC for the length of that one transaction and the transaction fails unless it burns exactly what it should. Either way, once signed, nobody can stop or redirect the transfer, and anyone can complete it."
        : "No. From Stellar your USDC moves from your wallet to Circle inside the one transaction you sign; from Arc your wallet calls Circle directly. Once signed, nobody can stop or redirect the transfer, and anyone can complete it.",
    },
    {
      q: "Which wallets can I use?",
      a: "To send from Stellar, Freighter or the LOBSTR browser extension. To send from Arc, any browser EVM wallet, such as MetaMask or Rabby. To receive, you only need an address on the destination chain; connecting a wallet there just fills it in.",
    },
    {
      q: "Is there a minimum or maximum amount?",
      a: `From Stellar, ${FEES.minTransferUsdc} to ${FEES.maxTransferUsdc} USDC per transfer, a limit kept low while the contract has had no external audit. On every route Circle's fee may be at most a tenth of what is burned, so the smallest transfer depends on the route; the bridge tells you if an amount is too small.`,
    },
    {
      q: "Which chains does Xebra support?",
      a: "Stellar to Solana and Arc, with more EVM chains added one at a time; Arc to Avalanche, OP Mainnet, Arbitrum, Base, Polygon, Unichain, Codex, Sonic, World Chain, Monad, Sei, XDC, HyperEVM, Ink and Solana. See [routes](/routes) for what is live.",
    },
    {
      q: "Why does sending to a new Solana wallet cost more?",
      a: "USDC on Solana lives in a token account. If the recipient does not have one yet, Circle opens it as part of the delivery, which costs more in Solana rent and so raises the delivery fee. The bridge checks and tells you before you sign.",
    },
    {
      q: "Has Xebra been audited?",
      a: "Not externally yet. The contracts are open source, transfers are capped, and the contracts can be paused instantly while any other change waits 48 hours. See [security](/security) for the details and how to report a problem.",
    },
    {
      q: "What is CCTP?",
      a: "Circle's Cross-Chain Transfer Protocol: Circle's own way of moving USDC between chains by burning it on one and minting it on another, with an attestation from Circle in between. Xebra is an interface and a fee wrapper on top of it.",
    },
  ];
}
