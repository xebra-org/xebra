import { describe, expect, it, vi } from "vitest";
import { OneClickError } from "../../../lib/near-intents/oneclick";
import { failure } from "./_body";

describe("failure helper for NEAR Intents routes", () => {
  it("returns 502 with message when OneClickError has status >= 500", async () => {
    const err500 = new OneClickError("NEAR Intents server error", 500);
    const res500 = failure(err500);
    expect(res500.status).toBe(502);
    expect(await res500.json()).toEqual({ error: "NEAR Intents server error" });

    const err503 = new OneClickError("Service unavailable", 503);
    const res503 = failure(err503);
    expect(res503.status).toBe(502);
    expect(await res503.json()).toEqual({ error: "Service unavailable" });
  });

  it("returns 422 with message when OneClickError has status < 500", async () => {
    const err400 = new OneClickError("Invalid recipient address", 400);
    const res400 = failure(err400);
    expect(res400.status).toBe(422);
    expect(await res400.json()).toEqual({ error: "Invalid recipient address" });

    const err422 = new OneClickError("No route available for this amount", 422);
    const res422 = failure(err422);
    expect(res422.status).toBe(422);
    expect(await res422.json()).toEqual({ error: "No route available for this amount" });
  });

  it("returns 504 when the operation timed out", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    const res = failure(timeoutError);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "The operation was aborted due to timeout" });

    const domTimeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const resDom = failure(domTimeout);
    expect(resDom.status).toBe(504);
    expect(await resDom.json()).toEqual({ error: "The operation was aborted due to timeout" });
  });

  it("returns 500 with fixed sentence and logs error for unexpected errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unexpectedErr = new Error("sensitive database connect ENOENT");

    const res = failure(unexpectedErr);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("An unexpected error occurred.");
    expect(body.error).not.toContain("sensitive");
    expect(errorSpy).toHaveBeenCalledWith("near intents failed", unexpectedErr);

    errorSpy.mockRestore();
  });
});
