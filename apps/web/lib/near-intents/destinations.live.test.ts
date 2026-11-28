import { describe, expect, it } from "vitest";
import { WANTED } from "./destinations";
import * as oneclick from "./oneclick";
import { ONECLICK_REFERRAL } from "./plan";
import { recipientProblem } from "./recipients";

/**
 * Every destination /near-intents offers, dry-quoted live from USDC on Base (the hub Xebra's CCTP
 * leg delivers to) at 25 USDC. A dry quote reserves nothing and issues no deposit address. Off by
 * default because it calls NEAR Intents' public API; run it with
 *
 *   XEBRA_LIVE_TESTS=1 pnpm --filter @xebra/web exec vitest run destinations.live
 *
 * A failure means 1Click stopped listing or quoting an asset, or stopped accepting the recipient
 * format below: fix or drop the entry in `destinations.ts` before people hit it.
 */
const RUN = process.env.XEBRA_LIVE_TESTS === "1";

const EVM = "0x65873f770200bfc51678c231e161061a1dd59e5e";
const SVM = "AahKfXBRiq6562C4sKHJpR64z3Crc5igaA72XCr21RQG";

/** One well-formed recipient per chain, each accepted by 1Click on 2026-11-28. */
const SAMPLE: Record<string, string> = {
  near: "87d52125d9681ea4b8ae2716d01d5000f59d37fbe84f49b8512fce3af472fcf3",
  sol: SVM,
  fogo: SVM,
  arb: EVM,
  eth: EVM,
  bsc: EVM,
  gnosis: EVM,
  bera: EVM,
  scroll: EVM,
  hood: EVM,
  adi: EVM,
  btc: "bc1qe592nptpg7mvtd8l9d7laew6yz4rsffsqfk7u9",
  zec: "t1JnnuVnA49EKC3CTXR8YsFPVV79DWFatTV",
  tron: "TBU4opRRv1EPGMKB1cXXZ8FYtGV8jiuabh",
  ton: "UQDpbjDHAeUm_J8cpyxX3Kg7KBJG8xL1L-dVqEqPkcmRYrkC",
  xrp: "r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSp",
  doge: "D8zRoR997uMex6ggsjY68zdm3RbRGkk939",
  ltc: "LYsuJkBPKgCXYvNi8AGrPu36NqCC4Y5BTw",
  bch: "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy",
  dash: "Xk9rBp37YPnBQ739mDLpauEj5AAcEcajRK",
  cardano:
    "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
  aleo: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
};

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

describe.skipIf(!RUN)("every NEAR Intents destination quotes live from Base USDC", () => {
  it.each(WANTED.map((w) => [`${w.symbol} on ${w.chain}`, w] as const))(
    "%s",
    async (_name, w) => {
      const recipient = SAMPLE[w.blockchain];
      expect(recipient, `no sample recipient for ${w.blockchain}`).toBeDefined();
      expect(recipientProblem(w.blockchain, recipient as string)).toBeNull();

      const list = await oneclick.tokens();
      const origin = list.find((t) => t.blockchain === "base" && t.contractAddress === BASE_USDC);
      const dest = list.find((t) => t.blockchain === w.blockchain && t.symbol === w.symbol);
      expect(origin, "Base USDC listed").toBeDefined();
      expect(dest, `${w.blockchain}/${w.symbol} listed`).toBeDefined();

      const { quote } = await oneclick.quote({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: origin?.assetId as string,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: dest?.assetId as string,
        amount: "25000000",
        refundTo: EVM,
        refundType: "ORIGIN_CHAIN",
        recipient: recipient as string,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        referral: ONECLICK_REFERRAL,
      });
      expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
      expect(quote.depositAddress).toBeUndefined();
    },
    60_000,
  );
});
