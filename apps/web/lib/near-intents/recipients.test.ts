import { describe, expect, it } from "vitest";
import { recipientProblem } from "./recipients";

/**
 * Each "good" address below is one 1Click's dry quote accepted on 2026-11-28 (Base USDC in,
 * 25 USDC), or a well-formed address of the same kind. Each "bad" one is one character off, the
 * wrong chain, or a format NEAR Intents refuses, so a person sees a plain sentence before signing.
 */

const EVM = "0x65873f770200bfc51678c231e161061a1dd59e5e";
const EVM_CHECKSUMMED = "0x65873F770200Bfc51678c231e161061a1Dd59E5E";

function ok(blockchain: string, recipient: string) {
  expect(recipientProblem(blockchain, recipient), `${blockchain}: ${recipient}`).toBeNull();
}
function bad(blockchain: string, recipient: string, says: RegExp) {
  const problem = recipientProblem(blockchain, recipient);
  expect(problem, `${blockchain}: ${recipient}`).not.toBeNull();
  expect(problem).toMatch(says);
}

describe("recipientProblem: XRP", () => {
  it("accepts classic r addresses", () => {
    ok("xrp", "r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSp");
    ok("xrp", "rGkruLbohNFQcR1Qxiq4WXLyWrMQx1pNW5");
  });
  it("refuses a typo, an EVM address and a tag glued on", () => {
    bad(
      "xrp",
      "r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSq",
      /That isn't an XRP address\. XRP addresses start with r/,
    );
    bad("xrp", EVM, /isn't an XRP address/);
    bad("xrp", "r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSp:12345", /isn't an XRP address/);
  });
  it("explains that an X address carries a destination tag NEAR Intents cannot deliver to", () => {
    // xrpl.org's X-address test vector: rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf with tag 4294967295.
    bad("xrp", "XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi", /destination tag/);
  });
});

describe("recipientProblem: Bitcoin family", () => {
  it("Dogecoin: D addresses, checksum checked (1Click itself let a bad one quote)", () => {
    ok("doge", "D8zRoR997uMex6ggsjY68zdm3RbRGkk939");
    bad(
      "doge",
      "D8zRoR997uMex6ggsjY68zdm3RbRGkk93a",
      /That isn't a Dogecoin address\. Dogecoin addresses start with D/,
    );
    // A pay-to-script address (9.../A...): 1Click answers "recipient is not valid".
    bad("doge", "9tgjDiJLkh5Wxktgw9Xd91SriVmpSa1zu3", /Dogecoin addresses start with D/);
  });
  it("Litecoin: L, M and ltc1", () => {
    ok("ltc", "LYsuJkBPKgCXYvNi8AGrPu36NqCC4Y5BTw");
    ok("ltc", "MDZj9A4MZuyoEJ4XPNm6wiwxceRgq9tSNU");
    ok("ltc", "ltc1q9e7jcqaf2pawye0v7k6n26y955ee8gsz0a6vsz");
    bad("ltc", "LdhAFf9tEbdZsZANz3HeFcNfdmFmvui4dE", /That isn't a Litecoin address/);
    bad("ltc", "1LXsTP2JF8nC9TunJzdEy4zjrXpEAvh2eN", /Litecoin addresses start with L, M or ltc1/);
  });
  it("Bitcoin Cash: cashaddr with or without its prefix", () => {
    ok("bch", "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy");
    ok("bch", "qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy");
    bad(
      "bch",
      "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyz",
      /That isn't a Bitcoin Cash address/,
    );
    // An old-style address is also a valid Bitcoin address: ask for the bitcoincash: form instead.
    bad("bch", "1LXsTP2JF8nC9TunJzdEy4zjrXpEAvh2eN", /bitcoincash:/);
  });
  it("Dash: X and 7", () => {
    ok("dash", "Xk9rBp37YPnBQ739mDLpauEj5AAcEcajRK");
    ok("dash", "7YCH9wD9cvQFfxMQBjVLTrPG6wzp3ZXimo");
    bad(
      "dash",
      "7YCH9wD9cvQFfxMQBjVLTrPG6wzp3ZXimp",
      /That isn't a Dash address\. Dash addresses start with X/,
    );
  });
  it("Bitcoin: 1, 3, bc1q and bc1p", () => {
    ok("btc", "1LXsTP2JF8nC9TunJzdEy4zjrXpEAvh2eN");
    ok("btc", "355dJp96oJLnrXdMTXWnjQMXUuaaBWZRtu");
    ok("btc", "bc1qe592nptpg7mvtd8l9d7laew6yz4rsffsqfk7u9");
    ok("btc", "bc1p4255qfny7xjp7s8th3fvnxf7ke4wkdnxq22clha29qahrejdky3scu7zfc");
    bad("btc", "355dJp96oJLnrXdMTXWnjQMXUuaaBWZRtv", /That isn't a Bitcoin address/);
    bad(
      "btc",
      "bc1qe592nptpg7mvtd8l9d7laew6yz4rsffsqfk7u8",
      /Bitcoin addresses start with 1, 3 or bc1/,
    );
    bad("btc", "LYsuJkBPKgCXYvNi8AGrPu36NqCC4Y5BTw", /isn't a Bitcoin address/);
  });
  it("Zcash: transparent t1 and t3 only", () => {
    ok("zec", "t1JnnuVnA49EKC3CTXR8YsFPVV79DWFatTV");
    ok("zec", "t3er2p4nwa8P2rHDwQBsEi53CtEawZ7StHS");
    bad("zec", "t1L7nzpvE5LZTJuMD1r7tGkqnCBXvhYi6z4", /t1 or t3/);
  });
});

describe("recipientProblem: other chains", () => {
  it("Cardano: addr1 payment addresses, not stake or Byron addresses", () => {
    ok(
      "cardano",
      "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
    );
    ok("cardano", "addr1v93vv6n6thtscv2xvxqx8s6yu5c7d494ncmeszzy8n5k9vcdkgg32");
    bad(
      "cardano",
      "addr1v93vv6n6thtscv2xvxqx8s6yu5c7d494ncmeszzy8n5k9vcdkgg33",
      /That isn't a Cardano address\. Cardano addresses start with addr1/,
    );
    bad("cardano", "stake1uyd3dvwl2w96ztwrl9ldhwzu4fc9p4rvzjqng2g0aw5qlqspr605l", /stake address/);
    bad(
      "cardano",
      "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi",
      /start with addr1/,
    );
  });
  it("Aleo: aleo1, checksum checked", () => {
    ok("aleo", "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px");
    bad(
      "aleo",
      "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9pq",
      /That isn't an Aleo address/,
    );
  });
  it("Tron: T addresses", () => {
    ok("tron", "TBU4opRRv1EPGMKB1cXXZ8FYtGV8jiuabh");
    bad(
      "tron",
      "TMrLPPVTxnwEgQnzWUW6S783ANSD3eLvUy",
      /That isn't a Tron address\. Tron addresses start with T/,
    );
  });
  it("TON: user-friendly (checksum checked) and raw forms", () => {
    ok("ton", "UQDpbjDHAeUm_J8cpyxX3Kg7KBJG8xL1L-dVqEqPkcmRYrkC");
    ok("ton", "EQDpbjDHAeUm_J8cpyxX3Kg7KBJG8xL1L-dVqEqPkcmRYuTH");
    ok("ton", "0:e96e30c701e526fc9f1ca72c57dca83b281246f312f52fe755a84a8f91c99162");
    bad("ton", "EQDpbjDHAeUm_J8cpyxX3Kg7KBJG8xL1L-dVqEqPkcmRYuXH", /That isn't a TON address/);
  });
  it("NEAR: named, implicit and EVM-style accounts", () => {
    ok("near", "alice.near");
    ok("near", "that-guy.near");
    ok("near", "87d52125d9681ea4b8ae2716d01d5000f59d37fbe84f49b8512fce3af472fcf3");
    ok("near", EVM);
    bad("near", "Alice.near", /That isn't a NEAR account/);
    bad("near", "alice..near", /isn't a NEAR account/);
    bad("near", "a", /isn't a NEAR account/);
  });
  it("Solana and Fogo: base58 public keys", () => {
    ok("sol", "AahKfXBRiq6562C4sKHJpR64z3Crc5igaA72XCr21RQG");
    ok("fogo", "AahKfXBRiq6562C4sKHJpR64z3Crc5igaA72XCr21RQG");
    bad("fogo", EVM, /That isn't a Fogo address/);
    bad("sol", "AahKfXBRiq6562C4sKHJpR64z3Crc5igaA72XCr21RQ0", /That isn't a Solana address/);
  });
});

describe("recipientProblem: EVM chains", () => {
  const evm = ["arb", "eth", "bsc", "gnosis", "bera", "scroll", "hood", "adi"];
  it("accepts lower-case and correctly checksummed 0x addresses on every EVM destination", () => {
    for (const b of evm) {
      ok(b, EVM);
      ok(b, EVM_CHECKSUMMED);
    }
  });
  it("names the chain when the address is not one", () => {
    bad(
      "bsc",
      "r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSp",
      /That isn't a BNB Chain address\. BNB Chain addresses start with 0x/,
    );
    bad("gnosis", "0x1234", /isn't a Gnosis address/);
  });
  it("catches a mistyped checksummed address", () => {
    bad("scroll", "0x65873F770200Bfc51678c231e161061a1Dd59E5e", /typo/);
  });
});

describe("recipientProblem: anything else", () => {
  it("trims spaces a paste picks up", () => {
    ok("xrp", "  r9ZAayKD2CLvyn9S4kKttXLiVS3wqKMQSp\n");
  });
  it("refuses an empty recipient", () => {
    bad("xrp", "   ", /Enter who receives/);
  });
  it("refuses a chain it has no rule for, rather than sending blind", () => {
    bad("abs", EVM, /doesn't send to/);
  });
});
