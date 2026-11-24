import type { ModuleInterface } from "@creit.tech/stellar-wallets-kit";

/** The text a wallet module's pre-check throws when the extension did not answer. */
const NOT_CONNECTED = /is not connected/i;

/** The calls that start with that pre-check, before the wallet shows anything to the person. */
const CHECKED_CALLS = [
  "getAddress",
  "signTransaction",
  "signAuthEntry",
  "signMessage",
  "getNetwork",
] as const;

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Makes a wallet module wait for a sleeping extension instead of calling it "not connected".
 *
 * # Why
 *
 * Before every call, the kit's Freighter and LOBSTR modules ask the extension whether it is
 * connected. Freighter's own library gives that question 2 seconds (`REQUEST_CONNECTION_STATUS` in
 * `@stellar/freighter-api`) and answers "not connected" when the time runs out. Browsers put idle
 * extensions to sleep, and waking one can take longer than that, so a person who connected
 * Freighter a few minutes earlier pressed Send and was told "Freighter is not connected". Only
 * disconnecting and connecting again, which woke the extension, got them through.
 *
 * # What this does
 *
 * When one of those calls fails its pre-check, the module asks again a few times, a little longer
 * apart each time (each question also helps wake the extension), and once it answers, runs the
 * call once more. The pre-check throws before the wallet shows any prompt, so the retry can never
 * ask the person to sign twice. Any other failure, including a refusal in the wallet, is passed on
 * unchanged.
 */
export function patient<M extends ModuleInterface>(
  mod: M,
  opts: { attempts?: number; pauseMs?: number } = {},
): M {
  const attempts = opts.attempts ?? 3;
  const pauseMs = opts.pauseMs ?? 400;

  async function wake(): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await mod.isAvailable().catch(() => false)) return true;
      await pause(pauseMs * (i + 1));
    }
    return false;
  }

  const target = mod as unknown as Record<string, unknown>;
  for (const name of CHECKED_CALLS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = async (...args: unknown[]) => {
      try {
        return await original.apply(mod, args);
      } catch (err) {
        if (!NOT_CONNECTED.test(errorText(err)) || !(await wake())) throw err;
        return original.apply(mod, args);
      }
    };
  }
  return mod;
}
