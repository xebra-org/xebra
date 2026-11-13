import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildSolanaBurnTransaction } from "@xebra/cctp-solana";
import { EVM_CHAINS } from "@xebra/sdk/core";
import { describe, expect, it } from "vitest";
import { solanaBurnParams } from "./plan";

/**
 * The whole Solana burn, as the build route makes it, simulated against Circle's live programs on
 * mainnet. Simulation only, with signature checks off: nothing is signed by the owner and nothing
 * is sent. Off by default because it reads a public RPC; run it with
 *
 *   SOLANA_MAINNET_SIM=1 SIM_OWNER=<a wallet holding USDC and a little SOL> pnpm exec vitest run simulate.mainnet
 *
 * A burn reaching `SendMessage` and returning success is the proof that the account list, flags,
 * data and compute budget are what Circle's program accepts for that destination.
 */
const RUN = process.env.SOLANA_MAINNET_SIM === "1";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OWNER = process.env.SIM_OWNER ?? "DtG5HoH4WKC6HjmdTm4k7PNreyQmB1UmpFfqHMCeNj9y";
const STELLAR_RECIPIENT = "GBHC3U6RUUU5NRX7SHZ2XC5HA5JIG364LOMVJLYWM72JFBANWSWYJ7ZV";

describe.skipIf(!RUN)("a Solana burn simulated on mainnet", () => {
  const connection = new Connection(RPC, "confirmed");
  const owner = new PublicKey(OWNER);

  async function simulate(params: ReturnType<typeof solanaBurnParams>) {
    const built = await buildSolanaBurnTransaction(connection, { owner, params });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    const logs = sim.value.logs ?? [];
    console.log(
      `domain ${params.destinationDomain}: ${sim.value.unitsConsumed} CU, ${Buffer.from(built.transaction, "base64").length} bytes, err=${JSON.stringify(sim.value.err)}\n${logs.join("\n")}`,
    );
    return { sim, logs };
  }

  it("to Base, forwarded by Circle", { timeout: 60_000 }, async () => {
    const { sim, logs } = await simulate(
      solanaBurnParams(
        {
          kind: "evm",
          chain: EVM_CHAINS.base,
          recipient: "0x140d18eaa68c34c3ca761988f83cf8c395526e1d",
        },
        1_000_000n,
        100_000n,
      ),
    );
    expect(sim.value.err).toBeNull();
    expect(logs.join("\n")).toMatch(/Instruction: DepositForBurnWithHook/);
    expect(logs.join("\n")).toMatch(/Instruction: SendMessage/);
  });

  it("to Arc, forwarded by Circle", { timeout: 60_000 }, async () => {
    const { sim } = await simulate(
      solanaBurnParams(
        {
          kind: "evm",
          chain: EVM_CHAINS.arc,
          recipient: "0x140d18eaa68c34c3ca761988f83cf8c395526e1d",
        },
        1_000_000n,
        50_000n,
      ),
    );
    expect(sim.value.err).toBeNull();
  });

  it("to Stellar, through Circle's CctpForwarder", { timeout: 60_000 }, async () => {
    const { sim, logs } = await simulate(
      solanaBurnParams({ kind: "stellar", recipient: STELLAR_RECIPIENT }, 1_000_000n, 0n),
    );
    expect(sim.value.err).toBeNull();
    expect(logs.join("\n")).toMatch(/Instruction: SendMessage/);
  });
});
